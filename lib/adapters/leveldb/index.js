'use strict';

var levelup = require('levelup');
var sublevel = require('level-sublevel/legacy');
var through = require('through2').obj;

var originalLeveldown;
function requireLeveldown() {
  // wrapped try/catch inside a function to confine code
  // de-optimalization
  try {
    originalLeveldown = require('leveldown');
  } catch (e) {}
}
requireLeveldown();

var errors = require('../../deps/errors');
var utils = require('../../utils');
var calculateWinningRev = require('../../deps/merge/winningRev');
var traverseRevTree = require('../../deps/merge/traverseRevTree');
var collectConflicts = require('../../deps/merge/collectConflicts');
var isDeleted = require('../../deps/docs/isDeleted');
var isLocalId = require('../../deps/docs/isLocalId');
var processDocs = require('../../deps/docs/processDocs');
var md5 = require('../../deps/md5');
var migrate = require('../../deps/migrate');
var Deque = require("double-ended-queue");
var atob = require('../../deps/binary/base64').atob;
var functionName = require('../../deps/functionName');
var readAsBluffer = require('./readAsBlobOrBuffer');
var prepareAttachmentForStorage = require('./prepareAttachmentForStorage');
var createEmptyBluffer = require('./createEmptyBlobOrBuffer');

var binStringToBluffer =
  require('../../deps/binary/binaryStringToBlobOrBuffer');

var LevelTransaction = require('./transaction');

var DOC_STORE = 'document-store';
var BY_SEQ_STORE = 'by-sequence';
var ATTACHMENT_STORE = 'attach-store';
var BINARY_STORE = 'attach-binary-store';
var LOCAL_STORE = 'local-store';
var META_STORE = 'meta-store';

// leveldb barks if we try to open a db multiple times
// so we cache opened connections here for initstore()
var dbStores = new utils.Map();

// store the value of update_seq in the by-sequence store the key name will
// never conflict, since the keys in the by-sequence store are integers
var UPDATE_SEQ_KEY = '_local_last_update_seq';
var DOC_COUNT_KEY = '_local_doc_count';
var UUID_KEY = '_local_uuid';

var MD5_PREFIX = 'md5-';

var safeJsonEncoding = {
  encode: utils.safeJsonStringify,
  decode: utils.safeJsonParse,
  buffer: false,
  type: 'cheap-json'
};

// winningRev and deleted are performance-killers, but
// in newer versions of PouchDB, they are cached on the metadata
function getWinningRev(metadata) {
  return 'winningRev' in metadata ?
    metadata.winningRev : calculateWinningRev(metadata);
}

function getIsDeleted(metadata, winningRev) {
  return 'deleted' in metadata ?
    metadata.deleted : isDeleted(metadata, winningRev);
}

function fetchAttachment(att, stores, opts) {
  var type = att.content_type;
  return new utils.Promise(function (resolve, reject) {
    stores.binaryStore.get(att.digest, function (err, buffer) {
      var data;
      if (err) {
        /* istanbul ignore if */
        if (err.name !== 'NotFoundError') {
          return reject(err);
        } else {
          // empty
          if (!opts.binary) {
            data = '';
          } else {
            data = binStringToBluffer('', type);
          }
        }
      } else { // non-empty
        if (opts.binary) {
          data = readAsBluffer(buffer, type);
        } else {
          data = buffer.toString('base64');
        }
      }
      delete att.stub;
      delete att.length;
      att.data = data;
      resolve();
    });
  });
}

function fetchAttachments(results, stores, opts) {
  var atts = [];
  results.forEach(function (row) {
    if (!(row.doc && row.doc._attachments)) {
      return;
    }
    var attNames = Object.keys(row.doc._attachments);
    attNames.forEach(function (attName) {
      var att = row.doc._attachments[attName];
      if (!('data' in att)) {
        atts.push(att);
      }
    });
  });

  return utils.Promise.all(atts.map(function (att) {
    return fetchAttachment(att, stores, opts);
  }));
}

function LevelPouch(opts, callback) {
  opts = utils.clone(opts);
  var api = this;
  var instanceId;
  var stores = {};
  var db;
  var name = opts.name;
  if (typeof opts.createIfMissing === 'undefined') {
    opts.createIfMissing = true;
  }

  var leveldown = opts.db || originalLeveldown;
  if (!leveldown) {
    /* istanbul ignore next */
    return callback(new Error(
      "leveldown not available " +
      "(specify another backend using the 'db' option)"
    ));
  }

  if (typeof leveldown.destroy !== 'function') {
    /* istanbul ignore next */
    leveldown.destroy = function (name, cb) { cb(); };
  }
  var dbStore;
  var leveldownName = functionName(leveldown);
  if (dbStores.has(leveldownName)) {
    dbStore = dbStores.get(leveldownName);
  } else {
    dbStore = new utils.Map();
    dbStores.set(leveldownName, dbStore);
  }
  if (dbStore.has(name)) {
    db = dbStore.get(name);
    afterDBCreated();
  } else {
    dbStore.set(name, sublevel(levelup(name, opts, function (err) {
      /* istanbul ignore if */
      if (err) {
        dbStore.delete(name);
        return callback(err);
      }
      db = dbStore.get(name);
      db._docCount  = -1;
      db._queue = new Deque();
      if (opts.db || opts.noMigrate) {
        afterDBCreated();
      } else {
        migrate.toSublevel(name, db, afterDBCreated);
      }
    })));
  }

  function afterDBCreated() {
    stores.docStore = db.sublevel(DOC_STORE, {valueEncoding: safeJsonEncoding});
    stores.bySeqStore = db.sublevel(BY_SEQ_STORE, {valueEncoding: 'json'});
    stores.attachmentStore =
      db.sublevel(ATTACHMENT_STORE, {valueEncoding: 'json'});
    stores.binaryStore = db.sublevel(BINARY_STORE, {valueEncoding: 'binary'});
    stores.localStore = db.sublevel(LOCAL_STORE, {valueEncoding: 'json'});
    stores.metaStore = db.sublevel(META_STORE, {valueEncoding: 'json'});
    migrate.localAndMetaStores(db, stores, function () {
      stores.metaStore.get(UPDATE_SEQ_KEY, function (err, value) {
        if (typeof db._updateSeq === 'undefined') {
          db._updateSeq = value || 0;
        }
        stores.metaStore.get(DOC_COUNT_KEY, function (err, value) {
          db._docCount = !err ? value : 0;
          stores.metaStore.get(UUID_KEY, function (err, value) {
            instanceId = !err ? value : utils.uuid();
            stores.metaStore.put(UUID_KEY, instanceId, function (err, value) {
              process.nextTick(function () {
                callback(null, api);
              });
            });
          });
        });
      });
    });
  }

  function countDocs(callback) {
    /* istanbul ignore if */
    if (db.isClosed()) {
      return callback(new Error('database is closed'));
    }
    return callback(null, db._docCount); // use cached value
  }

  api.type = function () {
    return 'leveldb';
  };

  api._id = function (callback) {
    callback(null, instanceId);
  };

  api._info = function (callback) {
    var res = {
      doc_count: db._docCount,
      update_seq: db._updateSeq,
      backend_adapter: functionName(leveldown)
    };
    return process.nextTick(function () {
      callback(null, res);
    });
  };

  function tryCode(fun, args) {
    try {
      fun.apply(null, args);
    } catch (err) {
      args[args.length - 1](err);
    }
  }

  function executeNext() {
    var firstTask = db._queue.peekFront();

    if (firstTask.type === 'read') {
      runReadOperation(firstTask);
    } else { // write, only do one at a time
      runWriteOperation(firstTask);
    }
  }

  function runReadOperation(firstTask) {
    // do multiple reads at once simultaneously, because it's safe

    var readTasks = [firstTask];
    var i = 1;
    var nextTask = db._queue.get(i);
    while (typeof nextTask !== 'undefined' && nextTask.type === 'read') {
      readTasks.push(nextTask);
      i++;
      nextTask = db._queue.get(i);
    }

    var numDone = 0;

    readTasks.forEach(function (readTask) {
      var args = readTask.args;
      var callback = args[args.length - 1];
      args[args.length - 1] = utils.getArguments(function (cbArgs) {
        callback.apply(null, cbArgs);
        if (++numDone === readTasks.length) {
          process.nextTick(function () {
            // all read tasks have finished
            readTasks.forEach(function () {
              db._queue.shift();
            });
            if (db._queue.length) {
              executeNext();
            }
          });
        }
      });
      tryCode(readTask.fun, args);
    });
  }

  function runWriteOperation(firstTask) {
    var args = firstTask.args;
    var callback = args[args.length - 1];
    args[args.length - 1] = utils.getArguments(function (cbArgs) {
      callback.apply(null, cbArgs);
      process.nextTick(function () {
        db._queue.shift();
        if (db._queue.length) {
          executeNext();
        }
      });
    });
    tryCode(firstTask.fun, args);
  }

  // all read/write operations to the database are done in a queue,
  // similar to how websql/idb works. this avoids problems such
  // as e.g. compaction needing to have a lock on the database while
  // it updates stuff. in the future we can revisit this.
  function writeLock(fun) {
    return utils.getArguments(function (args) {
      db._queue.push({
        fun: fun,
        args: args,
        type: 'write'
      });

      if (db._queue.length === 1) {
        process.nextTick(executeNext);
      }
    });
  }

  // same as the writelock, but multiple can run at once
  function readLock(fun) {
    return utils.getArguments(function (args) {
      db._queue.push({
        fun: fun,
        args: args,
        type: 'read'
      });

      if (db._queue.length === 1) {
        process.nextTick(executeNext);
      }
    });
  }

  function formatSeq(n) {
    return ('0000000000000000' + n).slice(-16);
  }

  function parseSeq(s) {
    return parseInt(s, 10);
  }

  api._get = readLock(function (id, opts, callback) {
    opts = utils.clone(opts);

    stores.docStore.get(id, function (err, metadata) {

      if (err || !metadata) {
        return callback(errors.error(errors.MISSING_DOC, 'missing'));
      }

      var rev = getWinningRev(metadata);
      var deleted = getIsDeleted(metadata, rev);
      if (deleted && !opts.rev) {
        return callback(errors.error(errors.MISSING_DOC, "deleted"));
      }

      rev = opts.rev ? opts.rev : rev;

      var seq = metadata.rev_map[rev];

      stores.bySeqStore.get(formatSeq(seq), function (err, doc) {
        if (!doc) {
          return callback(errors.error(errors.MISSING_DOC));
        }
        /* istanbul ignore if */
        if ('_id' in doc && doc._id !== metadata.id) {
          // this failing implies something very wrong
          return callback(new Error('wrong doc returned'));
        }
        doc._id = metadata.id;
        if ('_rev' in doc) {
          /* istanbul ignore if */
          if (doc._rev !== rev) {
            // this failing implies something very wrong
            return callback(new Error('wrong doc returned'));
          }
        } else {
          // we didn't always store this
          doc._rev = rev;
        }
        return callback(null, {doc: doc, metadata: metadata});
      });
    });
  });

  // not technically part of the spec, but if putAttachment has its own
  // method...
  api._getAttachment = function (attachment, opts, callback) {
    var digest = attachment.digest;
    var type = attachment.content_type;

    stores.binaryStore.get(digest, function (err, attach) {
      if (err) {
        /* istanbul ignore if */
        if (err.name !== 'NotFoundError') {
          return callback(err);
        }
        // Empty attachment
        return callback(null, opts.binary ? createEmptyBluffer(type) : '');
      }

      if (opts.binary) {
        callback(null, readAsBluffer(attach, type));
      } else {
        callback(null, attach.toString('base64'));
      }
    });
  };

  api._bulkDocs = writeLock(function (req, opts, callback) {
    var newEdits = opts.new_edits;
    var results = new Array(req.docs.length);
    var fetchedDocs = new utils.Map();
    var txn = new LevelTransaction();
    var docCountDelta = 0;
    var newUpdateSeq = db._updateSeq;

    // parse the docs and give each a sequence number
    var userDocs = req.docs;
    var docInfos = userDocs.map(function (doc, i) {
      if (doc._id && isLocalId(doc._id)) {
        return doc;
      }
      var newDoc = utils.parseDoc(doc, newEdits);

      if (newDoc.metadata && !newDoc.metadata.rev_map) {
        newDoc.metadata.rev_map = {};
      }

      return newDoc;
    });
    var infoErrors = docInfos.filter(function (doc) {
      return doc.error;
    });

    if (infoErrors.length) {
      return callback(infoErrors[0]);
    }

    // verify any stub attachments as a precondition test

    function verifyAttachment(digest, callback) {
      txn.get(stores.attachmentStore, digest, function (levelErr) {
        if (levelErr) {
          var err = errors.error(errors.MISSING_STUB,
                                'unknown stub attachment with digest ' +
                                digest);
          callback(err);
        } else {
          callback();
        }
      });
    }

    function verifyAttachments(finish) {
      var digests = [];
      userDocs.forEach(function (doc) {
        if (doc && doc._attachments) {
          Object.keys(doc._attachments).forEach(function (filename) {
            var att = doc._attachments[filename];
            if (att.stub) {
              digests.push(att.digest);
            }
          });
        }
      });
      if (!digests.length) {
        return finish();
      }
      var numDone = 0;
      var err;

      digests.forEach(function (digest) {
        verifyAttachment(digest, function (attErr) {
          if (attErr && !err) {
            err = attErr;
          }

          if (++numDone === digests.length) {
            finish(err);
          }
        });
      });
    }

    function fetchExistingDocs(finish) {
      var numDone = 0;
      var overallErr;
      function checkDone() {
        if (++numDone === userDocs.length) {
          return finish(overallErr);
        }
      }

      userDocs.forEach(function (doc) {
        if (doc._id && isLocalId(doc._id)) {
          // skip local docs
          return checkDone();
        }
        txn.get(stores.docStore, doc._id, function (err, info) {
          if (err) {
            /* istanbul ignore if */
            if (err.name !== 'NotFoundError') {
              overallErr = err;
            }
          } else {
            fetchedDocs.set(doc._id, info);
          }
          checkDone();
        });
      });
    }

    function autoCompact(callback) {

      var promise = utils.Promise.resolve();

      fetchedDocs.forEach(function (metadata, docId) {
        // TODO: parallelize, for now need to be sequential to
        // pass orphaned attachment tests
        promise = promise.then(function () {
          return new utils.Promise(function (resolve, reject) {
            var revs = utils.compactTree(metadata);
            api._doCompactionNoLock(docId, revs, {ctx: txn}, function (err) {
              /* istanbul ignore if */
              if (err) {
                return reject(err);
              }
              resolve();
            });
          });
        });
      });

      promise.then(function () {
        callback();
      }, callback);
    }

    function finish() {
      if (api.auto_compaction) {
        return autoCompact(complete);
      }
      return complete();
    }

    function writeDoc(docInfo, winningRev, winningRevIsDeleted, newRevIsDeleted,
                      isUpdate, delta, resultsIdx, callback2) {
      docCountDelta += delta;

      var err = null;
      var recv = 0;

      docInfo.metadata.winningRev = winningRev;
      docInfo.metadata.deleted = winningRevIsDeleted;

      docInfo.data._id = docInfo.metadata.id;
      docInfo.data._rev = docInfo.metadata.rev;

      if (newRevIsDeleted) {
        docInfo.data._deleted = true;
      }

      var attachments = docInfo.data._attachments ?
        Object.keys(docInfo.data._attachments) :
        [];

      function attachmentSaved(attachmentErr) {
        recv++;
        if (!err) {
          /* istanbul ignore if */
          if (attachmentErr) {
            err = attachmentErr;
            callback2(err);
          } else if (recv === attachments.length) {
            finish();
          }
        }
      }

      function onMD5Load(doc, key, data, attachmentSaved) {
        return function (result) {
          saveAttachment(doc, MD5_PREFIX + result, key, data, attachmentSaved);
        };
      }

      function doMD5(doc, key, attachmentSaved) {
        return function (data) {
          md5(data).then(
            onMD5Load(doc, key, data, attachmentSaved)
          );
        };
      }

      for (var i = 0; i < attachments.length; i++) {
        var key = attachments[i];
        var att = docInfo.data._attachments[key];

        if (att.stub) {
          // still need to update the refs mapping
          var id = docInfo.data._id;
          var rev = docInfo.data._rev;
          saveAttachmentRefs(id, rev, att.digest, attachmentSaved);
          continue;
        }
        var data;
        if (typeof att.data === 'string') {
          try {
            data = atob(att.data);
          } catch (e) {
            callback(errors.error(errors.BAD_ARG,
                     'Attachments need to be base64 encoded'));
            return;
          }
          doMD5(docInfo, key, attachmentSaved)(data);
        } else {
          prepareAttachmentForStorage(att.data,
            doMD5(docInfo, key, attachmentSaved));
        }
      }

      function finish() {
        var seq = docInfo.metadata.rev_map[docInfo.metadata.rev];
        /* istanbul ignore if */
        if (seq) {
          // check that there aren't any existing revisions with the same
          // revision id, else we shouldn't do anything
          return callback2();
        }
        seq = ++newUpdateSeq;
        docInfo.metadata.rev_map[docInfo.metadata.rev] =
          docInfo.metadata.seq = seq;
        var seqKey = formatSeq(seq);
        var batch = [{
          key: seqKey,
          value: docInfo.data,
          prefix: stores.bySeqStore,
          type: 'put'
        }, {
          key: docInfo.metadata.id,
          value: docInfo.metadata,
          prefix: stores.docStore,
          type: 'put'
        }];
        txn.batch(batch);
        results[resultsIdx] = {
          ok: true,
          id: docInfo.metadata.id,
          rev: winningRev
        };
        fetchedDocs.set(docInfo.metadata.id, docInfo.metadata);
        callback2();
      }

      if (!attachments.length) {
        finish();
      }
    }

    // attachments are queued per-digest, otherwise the refs could be
    // overwritten by concurrent writes in the same bulkDocs session
    var attachmentQueues = {};

    function saveAttachmentRefs(id, rev, digest, callback) {

      function fetchAtt() {
        return new utils.Promise(function (resolve, reject) {
          txn.get(stores.attachmentStore, digest, function (err, oldAtt) {
            /* istanbul ignore if */
            if (err && err.name !== 'NotFoundError') {
              return reject(err);
            }
            resolve(oldAtt);
          });
        });
      }

      function saveAtt(oldAtt) {
        var ref = [id, rev].join('@');
        var newAtt = {};

        if (oldAtt) {
          if (oldAtt.refs) {
            // only update references if this attachment already has them
            // since we cannot migrate old style attachments here without
            // doing a full db scan for references
            newAtt.refs = oldAtt.refs;
            newAtt.refs[ref] = true;
          }
        } else {
          newAtt.refs = {};
          newAtt.refs[ref] = true;
        }

        return new utils.Promise(function (resolve, reject) {
          txn.batch([{
            type: 'put',
            prefix: stores.attachmentStore,
            key: digest,
            value: newAtt
          }]);
          resolve(!oldAtt);
        });
      }

      // put attachments in a per-digest queue, to avoid two docs with the same
      // attachment overwriting each other
      var queue = attachmentQueues[digest] || utils.Promise.resolve();
      attachmentQueues[digest] = queue.then(function () {
        return fetchAtt().then(saveAtt).then(function (isNewAttachment) {
          callback(null, isNewAttachment);
        }, callback);
      });
    }

    function saveAttachment(docInfo, digest, key, data, callback) {
      var att = docInfo.data._attachments[key];
      delete att.data;
      att.digest = digest;
      att.length = data.length;
      var id = docInfo.metadata.id;
      var rev = docInfo.metadata.rev;

      saveAttachmentRefs(id, rev, digest, function (err, isNewAttachment) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        // do not try to store empty attachments
        if (data.length === 0) {
          return callback(err);
        }
        if (!isNewAttachment) {
          // small optimization - don't bother writing it again
          return callback(err);
        }
        txn.batch([{
          type: 'put',
          prefix: stores.binaryStore,
          key: digest,
          value: new Buffer(data, 'binary')
        }]);
        callback();
      });
    }

    function complete(err) {
      /* istanbul ignore if */
      if (err) {
        return process.nextTick(function () {
          callback(err);
        });
      }
      txn.batch([
        {
          prefix: stores.metaStore,
          type: 'put',
          key: UPDATE_SEQ_KEY,
          value: newUpdateSeq
        },
        {
          prefix: stores.metaStore,
          type: 'put',
          key: DOC_COUNT_KEY,
          value: db._docCount + docCountDelta
        }
      ]);
      txn.execute(db, function (err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        db._docCount += docCountDelta;
        db._updateSeq = newUpdateSeq;
        LevelPouch.Changes.notify(name);
        process.nextTick(function () {
          callback(null, results);
        });
      });
    }

    if (!docInfos.length) {
      return callback(null, []);
    }

    verifyAttachments(function (err) {
      if (err) {
        return callback(err);
      }
      fetchExistingDocs(function (err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        processDocs(docInfos, api, fetchedDocs, txn, results, writeDoc,
          opts, finish);
      });
    });
  });
  api._allDocs = readLock(function (opts, callback) {
    opts = utils.clone(opts);
    countDocs(function (err, docCount) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      var readstreamOpts = {};
      var skip = opts.skip || 0;
      if (opts.startkey) {
        readstreamOpts.gte = opts.startkey;
      }
      if (opts.endkey) {
        readstreamOpts.lte = opts.endkey;
      }
      if (opts.key) {
        readstreamOpts.gte = readstreamOpts.lte = opts.key;
      }
      if (opts.descending) {
        readstreamOpts.reverse = true;
        // switch start and ends
        var tmp = readstreamOpts.lte;
        readstreamOpts.lte = readstreamOpts.gte;
        readstreamOpts.gte = tmp;
      }
      var limit;
      if (typeof opts.limit === 'number') {
        limit = opts.limit;
      }
      if (limit === 0 ||
          ('start' in readstreamOpts && 'end' in readstreamOpts &&
          readstreamOpts.start > readstreamOpts.end)) {
        // should return 0 results when start is greater than end.
        // normally level would "fix" this for us by reversing the order,
        // so short-circuit instead
        return callback(null, {
          total_rows: docCount,
          offset: opts.skip,
          rows: []
        });
      }
      var results = [];
      var docstream = stores.docStore.readStream(readstreamOpts);

      var throughStream = through(function (entry, _, next) {
        var metadata = entry.value;
        // winningRev and deleted are performance-killers, but
        // in newer versions of PouchDB, they are cached on the metadata
        var winningRev = getWinningRev(metadata);
        var deleted = getIsDeleted(metadata, winningRev);
        if (!deleted) {
          if (skip-- > 0) {
            next();
            return;
          } else if (typeof limit === 'number' && limit-- <= 0) {
            docstream.unpipe();
            docstream.destroy();
            next();
            return;
          }
        } else if (opts.deleted !== 'ok') {
          next();
          return;
        }
        function allDocsInner(data) {
          var doc = {
            id: metadata.id,
            key: metadata.id,
            value: {
              rev: winningRev
            }
          };
          if (opts.include_docs) {
            doc.doc = data;
            doc.doc._rev = doc.value.rev;
            if (opts.conflicts) {
              doc.doc._conflicts = collectConflicts(metadata);
            }
            for (var att in doc.doc._attachments) {
              if (doc.doc._attachments.hasOwnProperty(att)) {
                doc.doc._attachments[att].stub = true;
              }
            }
          }
          if (opts.inclusive_end === false && metadata.id === opts.endkey) {
            return next();
          } else if (deleted) {
            if (opts.deleted === 'ok') {
              doc.value.deleted = true;
              doc.doc = null;
            } else {
              /* istanbul ignore next */
              return next();
            }
          }
          results.push(doc);
          next();
        }
        if (opts.include_docs) {
          var seq = metadata.rev_map[winningRev];
          stores.bySeqStore.get(formatSeq(seq), function (err, data) {
            allDocsInner(data);
          });
        }
        else {
          allDocsInner();
        }
      }, function (next) {
        utils.Promise.resolve().then(function () {
          if (opts.include_docs && opts.attachments){
            return fetchAttachments(results, stores, opts);
          }
        }).then(function () {
          callback(null, {
            total_rows: docCount,
            offset: opts.skip,
            rows: results
          });
        }, callback);
        next();
      }).on('unpipe', function () {
        throughStream.end();
      });

      docstream.on('error', callback);

      docstream.pipe(throughStream);
    });
  });

  api._changes = function (opts) {
    opts = utils.clone(opts);

    if (opts.continuous) {
      var id = name + ':' + utils.uuid();
      LevelPouch.Changes.addListener(name, id, api, opts);
      LevelPouch.Changes.notify(name);
      return {
        cancel: function () {
          LevelPouch.Changes.removeListener(name, id);
        }
      };
    }

    var descending = opts.descending;
    var results = [];
    var lastSeq = opts.since || 0;
    var called = 0;
    var streamOpts = {
      reverse: descending
    };
    var limit;
    if ('limit' in opts && opts.limit > 0) {
      limit = opts.limit;
    }
    if (!streamOpts.reverse) {
      streamOpts.start = formatSeq(opts.since || 0);
    }

    var docIds = opts.doc_ids && new utils.Set(opts.doc_ids);
    var filter = utils.filterChange(opts);
    var docIdsToMetadata = new utils.Map();

    var returnDocs;
    if ('returnDocs' in opts) {
      returnDocs = opts.returnDocs;
    } else {
      returnDocs = true;
    }

    function complete() {
      opts.done = true;
      if (returnDocs && opts.limit) {
        /* istanbul ignore if */
        if (opts.limit < results.length) {
          results.length = opts.limit;
        }
      }
      changeStream.unpipe(throughStream);
      changeStream.destroy();
      if (!opts.continuous && !opts.cancelled) {
        if (opts.include_docs && opts.attachments) {
          fetchAttachments(results, stores, opts).then(function () {
            opts.complete(null, {results: results, last_seq: lastSeq});
          });
        } else {
          opts.complete(null, {results: results, last_seq: lastSeq});
        }
      }
    }
    var changeStream = stores.bySeqStore.readStream(streamOpts);
    var throughStream = through(function (data, _, next) {
      if (limit && called >= limit) {
        complete();
        return next();
      }
      if (opts.cancelled || opts.done) {
        return next();
      }

      var seq = parseSeq(data.key);
      var doc = data.value;

      if (seq === opts.since && !descending) {
        // couchdb ignores `since` if descending=true
        return next();
      }

      if (docIds && !docIds.has(doc._id)) {
        return next();
      }

      var metadata;

      function onGetMetadata(metadata) {
        var winningRev = getWinningRev(metadata);

        function onGetWinningDoc(winningDoc) {

          var change = opts.processChange(winningDoc, metadata, opts);
          change.seq = metadata.seq;

          var filtered = filter(change);
          if (typeof filtered === 'object') {
            return opts.complete(filtered);
          }

          if (filtered) {
            called++;

            if (opts.attachments && opts.include_docs) {
              // fetch attachment immediately for the benefit
              // of live listeners
              fetchAttachments([change], stores, opts).then(function () {
                opts.onChange(change);
              });
            } else {
              opts.onChange(change);
            }

            if (returnDocs) {
              results.push(change);
            }
          }
          next();
        }

        if (metadata.seq !== seq) {
          // some other seq is later
          return next();
        }

        lastSeq = seq;

        if (winningRev === doc._rev) {
          return onGetWinningDoc(doc);
        }

        // fetch the winner

        var winningSeq = metadata.rev_map[winningRev];

        stores.bySeqStore.get(formatSeq(winningSeq), function (err, doc) {
          onGetWinningDoc(doc);
        });
      }

      metadata = docIdsToMetadata.get(doc._id);
      if (metadata) { // cached
        return onGetMetadata(metadata);
      }
      // metadata not cached, have to go fetch it
      stores.docStore.get(doc._id, function (err, metadata) {
        /* istanbul ignore if */
        if (opts.cancelled || opts.done || db.isClosed() ||
          isLocalId(metadata.id)) {
          return next();
        }
        docIdsToMetadata.set(doc._id, metadata);
        onGetMetadata(metadata);
      });
    }, function (next) {
      if (opts.cancelled) {
        return next();
      }
      if (returnDocs && opts.limit) {
        /* istanbul ignore if */
        if (opts.limit < results.length) {
          results.length = opts.limit;
        }
      }

      next();
    }).on('unpipe', function () {
      throughStream.end();
      complete();
    });
    changeStream.pipe(throughStream);
    return {
      cancel: function () {
        opts.cancelled = true;
        complete();
      }
    };
  };

  api._close = function (callback) {
    /* istanbul ignore if */
    if (db.isClosed()) {
      return callback(errors.error(errors.NOT_OPEN));
    }
    db.close(function (err) {
      /* istanbul ignore if */
      if (err) {
        callback(err);
      } else {
        dbStore.delete(name);
        callback();
      }
    });
  };

  api._getRevisionTree = function (docId, callback) {
    stores.docStore.get(docId, function (err, metadata) {
      if (err) {
        callback(errors.error(errors.MISSING_DOC));
      } else {
        callback(null, metadata.rev_tree);
      }
    });
  };

  api._doCompaction = writeLock(function (docId, revs, opts, callback) {
    api._doCompactionNoLock(docId, revs, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._doCompactionNoLock = function (docId, revs, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    if (!revs.length) {
      return callback();
    }
    var txn = opts.ctx || new LevelTransaction();

    txn.get(stores.docStore, docId, function (err, metadata) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      var seqs = metadata.rev_map; // map from rev to seq
      traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
                                                         revHash, ctx, opts) {
        var rev = pos + '-' + revHash;
        if (revs.indexOf(rev) !== -1) {
          opts.status = 'missing';
        }
      });
      var batch = [];
      batch.push({
        key: metadata.id,
        value: metadata,
        type: 'put',
        prefix: stores.docStore
      });

      var digestMap = {};
      var numDone = 0;
      var overallErr;
      function checkDone(err) {
        /* istanbul ignore if */
        if (err) {
          overallErr = err;
        }
        if (++numDone === revs.length) { // done
          /* istanbul ignore if */
          if (overallErr) {
            return callback(overallErr);
          }
          deleteOrphanedAttachments();
        }
      }

      function finish(err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        txn.batch(batch);
        if (opts.ctx) {
          // don't execute immediately
          return callback();
        }
        txn.execute(db, callback);
      }

      function deleteOrphanedAttachments() {
        var possiblyOrphanedAttachments = Object.keys(digestMap);
        if (!possiblyOrphanedAttachments.length) {
          return finish();
        }
        var numDone = 0;
        var overallErr;
        function checkDone(err) {
          /* istanbul ignore if */
          if (err) {
            overallErr = err;
          }
          if (++numDone === possiblyOrphanedAttachments.length) {
            finish(overallErr);
          }
        }
        var refsToDelete = new utils.Map();
        revs.forEach(function (rev) {
          refsToDelete.set(docId + '@' + rev, true);
        });
        possiblyOrphanedAttachments.forEach(function (digest) {
          txn.get(stores.attachmentStore, digest, function (err, attData) {
            /* istanbul ignore if */
            if (err) {
              if (err.name === 'NotFoundError') {
                return checkDone();
              } else {
                return checkDone(err);
              }
            }
            var refs = Object.keys(attData.refs || {}).filter(function (ref) {
              return !refsToDelete.has(ref);
            });
            var newRefs = {};
            refs.forEach(function (ref) {
              newRefs[ref] = true;
            });
            if (refs.length) { // not orphaned
              batch.push({
                key: digest,
                type: 'put',
                value: {refs: newRefs},
                prefix: stores.attachmentStore
              });
            } else { // orphaned, can safely delete
              batch = batch.concat([{
                key: digest,
                type: 'del',
                prefix: stores.attachmentStore
              }, {
                key: digest,
                type: 'del',
                prefix: stores.binaryStore
              }]);
            }
            checkDone();
          });
        });
      }

      revs.forEach(function (rev) {
        var seq = seqs[rev];
        batch.push({
          key: formatSeq(seq),
          type: 'del',
          prefix: stores.bySeqStore
        });
        txn.get(stores.bySeqStore, formatSeq(seq), function (err, doc) {
          /* istanbul ignore if */
          if (err) {
            if (err.name === 'NotFoundError') {
              return checkDone();
            } else {
              return checkDone(err);
            }
          }
          var atts = Object.keys(doc._attachments || {});
          atts.forEach(function (attName) {
            var digest = doc._attachments[attName].digest;
            digestMap[digest] = true;
          });
          checkDone();
        });
      });
    });
  };

  api._getLocal = function (id, callback) {
    stores.localStore.get(id, function (err, doc) {
      if (err) {
        callback(errors.error(errors.MISSING_DOC));
      } else {
        callback(null, doc);
      }
    });
  };

  api._putLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (opts.ctx) {
      api._putLocalNoLock(doc, opts, callback);
    } else {
      api._putLocalWithLock(doc, opts, callback);
    }
  };

  api._putLocalWithLock = writeLock(function (doc, opts, callback) {
    api._putLocalNoLock(doc, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._putLocalNoLock = function (doc, opts, callback) {
    delete doc._revisions; // ignore this, trust the rev
    var oldRev = doc._rev;
    var id = doc._id;

    var txn = opts.ctx || new LevelTransaction();

    txn.get(stores.localStore, id, function (err, resp) {
      if (err && oldRev) {
        return callback(errors.error(errors.REV_CONFLICT));
      }
      if (resp && resp._rev !== oldRev) {
        return callback(errors.error(errors.REV_CONFLICT));
      }
      doc._rev =
          oldRev ? '0-' + (parseInt(oldRev.split('-')[1], 10) + 1) : '0-1';
      var batch = [
        {
          type: 'put',
          prefix: stores.localStore,
          key: id,
          value: doc
        }
      ];

      txn.batch(batch);
      var ret = {ok: true, id: doc._id, rev: doc._rev};

      if (opts.ctx) {
        // don't execute immediately
        return callback(null, ret);
      }
      txn.execute(db, function (err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        callback(null, ret);
      });
    });
  };

  api._removeLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (opts.ctx) {
      api._removeLocalNoLock(doc, opts, callback);
    } else {
      api._removeLocalWithLock(doc, opts, callback);
    }
  };

  api._removeLocalWithLock = writeLock(function (doc, opts, callback) {
    api._removeLocalNoLock(doc, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._removeLocalNoLock = function (doc, opts, callback) {
    var txn = opts.ctx || new LevelTransaction();
    txn.get(stores.localStore, doc._id, function (err, resp) {
      if (err) {
        /* istanbul ignore if */
        if (err.name !== 'NotFoundError') {
          return callback(err);
        } else {
          return callback(errors.error(errors.MISSING_DOC));
        }
      }
      if (resp._rev !== doc._rev) {
        return callback(errors.error(errors.REV_CONFLICT));
      }
      txn.batch([{
        prefix: stores.localStore,
        type: 'del',
        key: doc._id
      }]);
      var ret = {ok: true, id: doc._id, rev: '0-0'};
      if (opts.ctx) {
        // don't execute immediately
        return callback(null, ret);
      }
      txn.execute(db, function (err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        callback(null, ret);
      });
    });
  };

  // close and delete open leveldb stores
  api._destroy = function (opts, callback) {
    var dbStore;
    var leveldownName = functionName(leveldown);
    /* istanbul ignore else */
    if (dbStores.has(leveldownName)) {
      dbStore = dbStores.get(leveldownName);
    } else {
      return callDestroy(name, callback);
    }

    /* istanbul ignore else */
    if (dbStore.has(name)) {
      LevelPouch.Changes.removeAllListeners(name);

      dbStore.get(name).close(function () {
        dbStore.delete(name);
        callDestroy(name, callback);
      });
    } else {
      callDestroy(name, callback);
    }
  };
  function callDestroy(name, cb) {
    /* istanbul ignore else */
    if (typeof leveldown.destroy === 'function') {
      leveldown.destroy(name, cb);
    } else {
      process.nextTick(cb);
    }
  }
}

LevelPouch.valid = function () {
  // this gets overriden by the *down-based browser adapters
  return true;
};

LevelPouch.use_prefix = false;

LevelPouch.Changes = new utils.Changes();

module.exports = LevelPouch;
