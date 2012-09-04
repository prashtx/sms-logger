/*jslint node:true */
'use strict';

/*
 * SMS Logger
 * Logs information from the bus arrivals SMS service to a postgresql database.
 */

var express = require('express');
var http = require('http');
var Q = require('q');
var pg = require('pg');

// Configuration
var port = process.env.PORT || 3001;
var databaseUrl = process.env.DATABASE_URL;

var app = express();
var server = http.createServer(app);
var dbClient = new pg.Client(databaseUrl);

function dbConnect() {
  var def = Q.defer();
  dbClient.connect(def.makeNodeResolver());
  return def.promise;
}

function query(queryInfo) {
  var def = Q.defer();
  dbClient.query(queryInfo, def.makeNodeResolver());
  return def.promise;
}

function setupDB() {
  return query({
    text: 'CREATE TABLE IF NOT EXISTS sms_log(' +
      'id SERIAL PRIMARY KEY,' +
      'user_id varchar(16),' +
      'timestamp timestamp DEFAULT CURRENT_TIMESTAMP,' +
      'message text,' +
      'response_count integer,' +
      'stop_id text,' +
      'continuation boolean DEFAULT FALSE,' +
      'lon double precision, lat double precision,' +
      'geocoder text,' +
      'error boolean DEFAULT FALSE)',
    name: 'ensureTable'
  });
}

app.use(express.json());

app.post('/log', function (req, resp) {
  var data = req.body;
  if (data === undefined || data.user === undefined) {
    resp.send(400);
    return;
  }

  // Default to FALSE rather than NULL.
  if (data.continuation === undefined) {
    data.continuation = false;
  }

  // Default to FALSE rather than NULL.
  if (data.error === undefined) {
    data.error = false;
  }

  query({
    text: 'INSERT INTO sms_log(user_id, message, response_count, stop_id, continuation, lon, lat, geocoder, error) ' +
      'VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    values: [data.user, data.message, data.responseCount, data.stopID, data.continuation, data.lon, data.lat, data.geocoder, data.error],
    name: 'addEntry'
  })
  .then(function () {
    resp.send(201);
  })
  .fail(function (error) {
    console.log(error);
    resp.send(500);
  })
  .end();
});

app.get('/metrics/users', function (req, resp) {
  query({
    text: 'SELECT COUNT(*) FROM (SELECT DISTINCT user_id FROM sms_log) as byuser',
    name: 'userCount'
  })
  .then(function (result) {
    resp.send({
      count: result.rows[0].count
    });
  })
  .fail(function (error) {
    console.log(error);
    resp.send(500);
  })
  .end();
});

app.get('/metrics/messages', function (req, resp) {
  var time;
  if (req.query.after !== undefined) {
    var unixTime = parseInt(req.query.after, 10);
    if (isNaN(unixTime)) {
      resp.send(400);
      return;
    }
    time = new Date(unixTime);
  } else {
    time = new Date(0);
  }
  query({
    text: 'SELECT COUNT(*) FROM sms_log WHERE timestamp > $1',
    values: [time],
    name: 'messageCount'
  })
  .then(function (result) {
    resp.send({
      count: result.rows[0].count
    });
  })
  .fail(function (error) {
    console.log(error);
    resp.send(500);
  })
  .end();
});


// TODO: handle reconnection
Q.all([dbConnect(), setupDB()])
.then(function () {
  console.log('Connected to database.');
  // Start the server.
  server.listen(port, function (error) {
    if (error) {
      throw error;
    }
    console.log('Listening on ' + port);
  });
})
.fail(function (error) {
  console.log('Database connection/setup failed.');
  console.log(error);
});

