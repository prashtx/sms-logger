/*jslint node:true */
'use strict';

/*
 * SMS Logger
 * Logs information from the bus arrivals SMS service to a postgresql database.
 */

var querystring = require('querystring');
var express = require('express');
var http = require('http');
var Q = require('q');
var pg = require('pg');
var s3 = require('connect-s3');

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

// Parse a string representation of Unix time into a Date object
function parseUnixTime(str) {
  if (str === undefined) {
    return null;
  }
  var unixTime = parseInt(str, 10);
  if (isNaN(unixTime)) {
    throw new Error('Unable to parse string as Unix time.');
  }
  return new Date(unixTime);
}

app.use(express.json());
app.use(express.compress());

app.use(s3({
  pathPrefix: '/web',
  remotePrefix: process.env.STATIC_PREFIX
}));


app.use(function (req, resp, next) {
  resp.header('Access-Control-Allow-Origin', '*');
  next();
});

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
  .done();
});

app.get('/metrics/users', function (req, resp) {
  var after;
  var until;
  try {
    after = parseUnixTime(req.query.after);
    until = parseUnixTime(req.query.until);
  } catch (e) {
    resp.send(400);
    return;
  }
  if (after === null) {
    after = new Date(0);
  }
  if (until === null) {
    until = new Date();
  }

  query({
    text: 'SELECT COUNT(*) FROM (SELECT DISTINCT user_id FROM sms_log WHERE timestamp > $1 AND timestamp <= $2) as byuser',
    values: [after, until],
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
  .done();
});

app.get('/metrics/messages', function (req, resp) {
  var after;
  var until;
  try {
    after = parseUnixTime(req.query.after);
    until = parseUnixTime(req.query.until);
  } catch (e) {
    resp.send(400);
    return;
  }
  if (after === null) {
    after = new Date(0);
  }
  if (until === null) {
    until = new Date();
  }

  query({
    text: 'SELECT COUNT(*) FROM sms_log WHERE timestamp > $1 AND timestamp <= $2',
    values: [after, until],
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
  .done();
});

function sendCsv(rows, resp) {
  resp.setHeader('Content-Type', 'text/plain');

  if (rows.length > 0) {
    // Headers
    var header;
    var headers = [];
    for (header in rows[0]) {
      if (rows[0].hasOwnProperty(header)) {
        headers.push(header);
      }
    }
    resp.write(JSON.stringify(headers));
    resp.write('\n');

    // Data rows
    var i;
    var j;
    var row = [];
    for (i = 0; i < rows.length; i += 1) {
      for (j = 0; j < headers.length; j += 1) {
        row[j] = rows[i][headers[j]];
      }
      resp.write(JSON.stringify(row));
      resp.write('\n');
    }

    resp.end();
  } else {
    resp.end();
  }
}

function returnMessages(req, resp) {
  var format = req.outputFormat;

  var startIndex = req.query.startIndex;
  var count = req.query.count;
  if (startIndex === undefined) {
    startIndex = 0;
  } else {
    startIndex = parseInt(startIndex, 10);
  }
  if (count === undefined) {
    count = null;
  } else {
    count = parseInt(count, 10);
  }
  if (isNaN(startIndex) || isNaN(count)) {
    resp.send(400);
    return;
  }

  var select = req.query.$select;
  // For now, we only support certain forms of this request
  if (select === undefined) {
    query({
      text: 'SELECT * FROM sms_log ORDER BY timestamp OFFSET $1 LIMIT $2',
      values: [startIndex, count],
      name: 'messages'
    })
    .then(function (result) {
      if (format === 'json') {
        resp.send(result.rows);
      } else if (format === 'csv') {
        sendCsv(result.rows, resp);
      } else {
        resp.send(500);
      }
    }, function (reason) {
      console.log(reason);
      resp.end();
    })
    .fail(function (error) {
      console.log(error);
      resp.send(500);
    })
    .done();
    return;
  }

  if (select !== 'timestamp') {
    resp.send(501);
    return;
  }

  query({
    text: 'SELECT timestamp FROM sms_log ORDER BY timestamp OFFSET $1 LIMIT $2',
    values: [startIndex, count],
    name: 'timestamps'
  })
  .then(function (result) {
    if (format === 'json') {
      resp.send(result.rows);
    } else if (format === 'csv') {
      sendCsv(result.rows, resp);
    } else {
      resp.send(500);
    }
  })
  .fail(function (error) {
    console.log(error);
    resp.send(500);
  })
  .done();
}

function setOutputFormat(format) {
  return function (req, res, next) {
    req.outputFormat = format;
    next();
  };
}

// Fetch raw data as JSON
app.get('/data/messages', setOutputFormat('json'), returnMessages);

// Fetch raw data as CSV
app.get('/data/messages.csv', setOutputFormat('csv'), returnMessages);


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

