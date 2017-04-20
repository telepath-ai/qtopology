"use strict";

const async = require("async");
const tn = require("../../").local;
const validator = require("../../").util.validation;

// demo configuration
let config = require("./topology.json");
validator.validate({ config: config, exitOnError: true });
let topology = new tn.TopologyLocal();

async.series(
    [
        (xcallback) => {
            topology.init(config, xcallback);
        },
        (xcallback) => {
            console.log("Init done");
            topology.run();
            setTimeout(() => {
                xcallback();
            }, 10000);
        },
        (xcallback) => {
            console.log("Starting shutdown sequence...");
            topology.shutdown(xcallback);
            topology = null;
        }
    ],
    (err) => {
        if (err) {
            console.log("Error", err);
        }
        console.log("Finished.");
    }
);

function shutdown(err) {
    if (topology) {
        topology.shutdown((err) => {
            if (err) {
                console.log("Error", err);
            }
            process.exit(1);
        });
        topology = null;
    }
}

//do something when app is closing
process.on('exit', shutdown);

//catches ctrl+c event
process.on('SIGINT', shutdown);

//catches uncaught exceptions
process.on('uncaughtException', shutdown);
