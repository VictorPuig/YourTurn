var config = require('../config');
var fcm = require('../fcm');
var _async = require('async');
var request = require('request');

var Store = require('../models/Store');
var Super = require('../models/Super');
var Turn = require('../models/Turn');
var User = require('../models/User');
var Totem = require('../models/Totem');

var computeQueue = function(store) {
  store = store.toObject();
  store.queue = store.users.length;
  return store;
}

module.exports.updateTurn = function updateTurn(turnId, obj, cb) {
  Turn.findById(turnId, function(err, foundTurn) {
    if (err)
      return cb(err);

    if (obj.queue)
      foundTurn.queue = obj.queue;

    if (obj.aproxTime)
      foundTurn.aproxTime = obj.aproxTime;

    foundTurn.save(function(err) {
      if (err)
        return cb(err);

      cb(null);
    });
  });
}

module.exports.newStore = function newStore(obj, cb) {
  var store = new Store();

  if (obj.name)
    store.name = obj.name;

  var superId;
  if (obj.superId)
    superId = obj.superId;
  else
    return cb('No super_id specified');

  store.storeTurn = 1;
  store.usersTurn = 1;
  store.users = [];
  store.screens = [];

  Super.findOne({_id: superId}, 'stores')
  .populate('stores')
  .exec(function (err, result) {
    if(err)
      cb(err);

    var storeNames = result.stores.map(function(s) {
      return s.name;
    });

    var storeFound = storeNames.indexOf(store.name) !== -1;

    if (storeFound)
      return cb('This store already exists');

    store.save(function(err, newStore) {
      if (err)
        return cb(err);

      // save the store and check for errors
      var supermrkt = new Super();
      Super.update({_id: superId}, {$push: {stores: store._id}}, function (err, raw){
        if (err)
          return cb(err);

        cb(null, {storeId: newStore._id, superId: superId});
      });
    });
  });
};

module.exports.postEvent = function postEvent(newEventype, storeId, cb) {
  request({
    url: config.caesar.address + "/events",
    method: 'POST',
    json: true,
    body: {
      eventype: newEventype,
      storeId: storeId
    }
  }, function(err, res, body) {
    if (err || res.statusCode != 200) {
      console.log(err);
      return;
    }
  });
}

var turnRequest = module.exports.turnRequest = function turnRequest(turn, storeTurn, cb) {
  //return new Promise(function(resolve, reject) {
    request({
      url: config.node.address + "/users/" + turn.userId,
      method: 'GET',
      json: true
    }, function(err, res, user) {

      if (err) {
        console.log(err);
        return cb(err);
      }

      if (!user)
        return cb(null);

      //Si la resta entre el torn actual de la parada i el torn demanat per l'usuari = les seves preferencies, retornem
      var queue = turn.turn - storeTurn; // Aixo nomes funciona amb els torns de manera sequencial!!!!!!!!

      var data = {
        turnId: turn._id,
        user: user,
        queue: queue
      };

      data.notify = queue == user.notificationTurns;

      getAverageTime(turn.storeId, function (err, time) {
        if (err)
          return cb(err);
          if (turn.queue)
            data.aproxTime = time;
            
        return cb(null, data);
      });
    })
}

module.exports.getStoreTurns = function getStoreTurns(storeId, cb) {

  request({
    url: config.node.address + "/turns/store/" + storeId,
    method: 'GET',
    json: true
  }, function(err, res, body) {

    if (err) {
      console.log(err);
      return;
    }
    cb(err,body);
  });
}

var getAverageTime = module.exports.getAverageTime = function getAverageTime(storeId, cb) {
  request({
    url: config.caesar.address + "/averageTime/" + storeId,
    method: 'GET',
    json: true
  }, function(err, res, body) {
      cb(err,body);
  });
}

module.exports.getStoreList = function getStoreList(cb) {
  Store.find()
  .populate('screens')
  .exec(function(err, stores) {
    if (err)
      return cb(err);

    cb(null, stores.map(computeQueue));
  });
};

var getStoreById = module.exports.getStoreById = function getStoreById(id, cb) {
  Store.findById(id, function(err, foundStore) {
    if (err)
      return cb(err);

    cb(null, foundStore ? computeQueue(foundStore) : null);
  });
};

module.exports.updateStore = function updateStore(id, obj, cb) {
  Store.findById(id, function(err, foundStore) {
    if (err)
      return cb(err);

    if (obj.name)
      foundStore.name = obj.name;

    if (obj.aproxTime)
      foundStore.aproxTime = obj.aproxTime;
    foundStore.save(function(err) {
      if (err)
        return cb(err);

      cb(null);
    });
  });
};

module.exports.removeStore = function removeStore(id, cb) {
  Store.remove({_id: id}, function(err, store) {
    if (err)
      return cb(err);

    cb(null);
  });
};

module.exports.addUserToStoreQueue = function addUserToStoreQueue(uid, sid, cb) {
  Store.find({_id: sid, users: {$elemMatch: {$eq: uid}}}, function(err, store){
    if(err)
      return cb(err);

    Totem.find({_id: uid}, function(err, totem) { //Sino trobem cap totem amb aquesta id vol dir que aquesta id es d'un usuari
                                                  //i si store.length > 0 vol dir que ja ha demanat torn en aquella parada
      if (store.length > 0 && totem.length == 0)
         return cb('This user already picked a ticket in this store!');

      //Executem el seguent codi amb waterfall per a que si es dona el cas de que el torn demanat ve d'un totem
      //Creem un nou usuari "fantasma" que pertany a aquell totem i a continuacio treballem amb aquella userID
      _async.waterfall([
        function(callback) {
          var userId = uid;
          //La id pertany a un totem
          if (totem.length > 0) {
            //Creem un usuari "fantasma" per al totem per aquell torn demanat
            var totemUser = new User();
            totemUser.totemId = uid; //Asignem el totemID
            totemUser.save(function(err, newTotemUser) {
              userId = newTotemUser._id;
              return callback(null, userId);
            });
          }
          else
            callback(null,userId);
        }
      ], function (err, idUserResult) {
          Store.findByIdAndUpdate(
            {_id: sid},
            {$push: {users: idUserResult}},
            {safe: true, upsert: true, new: true},
            function (err, storeToUpdate){
              if (err)
                return cb(err);

              var userTurn = storeToUpdate.usersTurn;
              storeToUpdate.usersTurn++;

              if (storeToUpdate.usersTurn > config.stores.maxTurn)
                storeToUpdate.usersTurn = 1;

              fcm.FCMNotificationBuilder()
                .setTopic('store.' + storeToUpdate._id)
                .addData('usersTurn', storeToUpdate.usersTurn)
                .addData('storeQueue',storeToUpdate.users.length)
                .send(function(err, res) {
                if (err)
                  console.log('FCM error:', err);
                });


                // update time i queue
                var turn = new Turn();
                turn.storeId = storeToUpdate._id;
                turn.turn = userTurn;
                turn.userId = idUserResult;

                turnRequest(turn, storeToUpdate.storeTurn, function(err, data) {
                  if (data) {
                    turn.aproxTime = data.aproxTime;
                    turn.queue = data.queue;
                  }

                  turn.save(function(err, newTurn) {
                    if (err)
                      return cb(err);

                      User.findByIdAndUpdate(
                        {_id: idUserResult},
                        {$push: {turns: newTurn._id}},
                        {safe: true, upsert: true, new: true},
                        function (err, foundUser) {
                          if (err)
                            return cb(err);
                        }
                      )
                  });

                storeToUpdate.save(function(err) {
                  if (err)
                    return cb(err);

                  var data = {
                    userTurn: userTurn,
                    store: storeToUpdate
                  };
                  cb(null, data);
                });
              });
            }
          );
        });
      });
  });
};

module.exports.removeStoreLastTurn = function removeStoreLastTurn (store, cb) {

  if (store.users[0] == undefined)
    return cb(null, "User not found");

  _async.waterfall([
     function(callback) {
       console.log("userIdFound: ", store.users[0]);
       request({
        url: config.node.address + "/users/" + store.users[0],
        method: 'GET',
        json: true
      }, function(err, res, user) {
        if (err || res.statusCode != 200) {
          console.log(err);
          return;
        }

        callback(null, user);
      });
     }
    ], function(err, user) {
      var userTurnInStore = user.turns.filter(function(el) {return el.storeId == store._id;});
      request({
        url: config.node.address + "/turn/" + userTurnInStore[0]._id,
        method: 'DELETE',
        json: true
      }, function(err, res, body) {
        if (err || res.statusCode != 200) {
          console.log(err);
          return;
        }
        cb(null, user);
      });
    });
}

module.exports.removeUserFromStoreQueue = function removeUserFromStoreQueue(uid, sid, cb) {
  Store.update(
    {_id: sid},
    {$pull: {users: uid}},
    {multi: true},
    function(err, user) {
      if (err)
        return cb(err);

      cb(null);
    });
}

module.exports.getStoreTurn = function getStoreTurn(id, cb) {
  Store.findById(id, function(err, foundStore) {
    if (err)
      return cb(err);

    cb(null, foundStore.storeTurn);
  });
};

module.exports.getStoreQueue = function getStoreQueue(id, cb) {
  Store.findById(id, function(err, foundStore) {
    if (err)
      return cb(err);

    fcm.FCMNotificationBuilder()
      .setTopic('store.' + foundStore._id)
      .addData('storeQueue', foundStore.users.length)
      .send(function(err, res) {
      if (err)
        console.log('FCM error:', err);
    });

    cb(null, foundStore.users.length);
  });
};

module.exports.advanceStoreTurn = function advanceStoreTurn(id, cb) {
  Store.findById(id , function (err, foundStore){
    if (err)
      return cb(err);

    foundStore.storeTurn++;

    if (foundStore.storeTurn > config.stores.maxTurn)
      foundStore.storeTurn = 1;

    _async.series([

      function(cb) {
        Store.update(
          {_id: id},
          {$pull: {users: foundStore.users[0]}}, //Treiem l'ultim usuari de la cua de la botiga
          {multi: true},
          function(err, user) {
            if (err)
              return cb(err);

            cb(null);
          }
        );
      },

      function(cb) {
        foundStore.save(function(err) {
          cb(err);
        });
      }
    ],

    function(err) {
      if (err)
        return cb(err);

      fcm.FCMNotificationBuilder()
        .setTopic('store.' + foundStore._id)
        .addData('storeTurn', foundStore.storeTurn)
        .send(function(err, res) {
         if (err)
           console.log('FCM error:', err);
        });

      cb(null, foundStore.storeTurn);
    });
  });
};
