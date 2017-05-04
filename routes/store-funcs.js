var config = require('../config');
var fcm = require('../fcm');
var _async = require('async');
var request = require('request');

var Store = require('../models/Store');
var Super = require('../models/Super');
var Turn = require('../models/Turn');
var User = require('../models/User');

var computeQueue = function(store) {
  store = store.toObject();
  store.queue = store.users.length;
  return store;
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

module.exports.turnRequest = function turnRequest(turn, storeTurn, cb) {
  //return new Promise(function(resolve, reject) {
    request({
      url: config.node.address + "/users/" + turn.userId,
      method: 'GET',
      json: true
    }, function(err, res, user) {

      if (err) {
        console.log(err);
        return;
      }
      //Si la resta entre el torn actual de la parada i el torn demanat per l'usuari = les seves preferencies, retornem
      var queue = turn.turn - storeTurn;
      console.log("queue", queue);
      console.log("notificationTurns", user.notificationTurns);

      var data = {
        user: user,
        queue: queue
      };

      data.notify = queue == user.notificationTurns;

      //resolve(data);
      return cb(null, data);
  //  });
  })
}
module.exports.notifyUser = function notifyUser(turns, storeTurn, storeId, cb) {
  var promises = turns.map(function(turn) {
    var promise = turnRequest(turn, storeTurn);
    return promise;
  });

  Promise.all(promises).then(function(data) {
    console.log("DATA", data);

    data.forEach(function(el){

      //Per cada torn demanat en aquesta parada, avisem a la app que ha de restar -1 a la cua del usuari
      for (i = 0; i < turns.length; i++) {
        //mqttClient.publish('etorn/store/' + req.params.store_id + '/user/' + userIds[i] + '/queue');
        fcm.FCMNotificationBuilder()
          .setTopic('store.' + req.params.store_id + '.user.' + userIds[i])
          .addData('storeTurn', 'advance')
          .addData('queue', turns[i].queue)
          .send(function(err, res) {
            if (err)
              console.log('FCM error:', err);
          });
      }

      if (el.userId) {
        //mqttClient.publish('etorn/store/' + storeId + '/user/' + el + '/notification');
        console.log("res", el);
        fcm.FCMNotificationBuilder()
          .setTopic('store.' + storeId + '.user.' + el.userId)
          .addData('notification', el.queue) //App decideix quin missatge enviar com a notificacio
          .send(function(err, res) {
            if (err)
              console.log('FCM error:', err);
          });
      }
    });

    cb(null,data);
  });
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

module.exports.getAverageTime = function getAverageTime(storeId, cb) {

  request({
    url: config.caesar.address + "/averageTime/" + storeId,
    method: 'GET',
    json: true
  }, function(err, res, body) {

    fcm.FCMNotificationBuilder()
      .setTopic('store.' + storeId)
      .addData('aproxTime', body) // arriba null
      .send(function(err, res) {
       if (err)
         console.log('FCM error:', err);
      });
      cb(err,body);
  });
}

module.exports.getStoreList = function getStoreList(cb) {
  Store.find(function(err, stores) {
    if (err)
      return cb(err);

    cb(null, stores.map(computeQueue));
  });
};

module.exports.getStoreById = function getStoreById(id, cb) {
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

    if (store.length > 0)
     return cb('This user already picked a ticket in this store!');

    Store.findByIdAndUpdate(
      {_id: sid},
      {$push: {users: uid}},
      {safe: true, upsert: true, new: true},
      function (err, foundStore){
        if (err)
          return cb(err);

        var userTurn = foundStore.usersTurn;
        foundStore.usersTurn++;

        if (foundStore.usersTurn > config.stores.maxTurn)
          foundStore.usersTurn = 1;

        fcm.FCMNotificationBuilder()
          .setTopic('store.' + foundStore._id)
          .addData('usersTurn', foundStore.usersTurn)
          .addData('storeQueue',foundStore.users.length)
          .send(function(err, res) {
           if (err)
             console.log('FCM error:', err);
          });


        var turn = new Turn();
        turn.storeId = foundStore._id;
        turn.turn = userTurn;
        turn.userId = uid;

        turn.save(function(err, newTurn) {
          if (err)
            return cb(err);

            User.findByIdAndUpdate(
              {_id: uid},
              {$push: {turns: newTurn._id}},
              {safe: true, upsert: true, new: true},
              function (err, foundUser) {
                if (err)
                  return cb(err);
              }
            )
        });

        foundStore.save(function(err) {
          if (err)
            return cb(err);

          cb(null, userTurn);
        });
      }
    );
  });
};

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