import * as async from "async";
import * as tlp from "./topology_local_proxy";
import * as coord from "./topology_coordinator";
import * as comp from "../topology_compiler";
import * as intf from "../topology_interfaces";
import * as log from "../util/logger";

/** Utility class for holding data about single topology */
class TopologyItem {
    uuid: string;
    config: any;
    proxy: tlp.TopologyLocalProxy;
}

/** This class handles topology worker - singleton instance on
 * that registers with coordination storage, receives instructions from
 * it and runs assigned topologies as subprocesses.
*/
export class TopologyWorker {
    private log_prefix: string;
    private overrides: any;
    private coordinator: coord.TopologyCoordinator;
    private topologies: TopologyItem[];
    private waiting_for_shutdown: boolean;

    /** Initializes this object */
    constructor(name: string, storage: intf.CoordinationStorage, overrides?: object) {
        this.log_prefix = `[Worker ${name}] `;
        this.overrides = overrides || {};
        this.waiting_for_shutdown = false;
        this.topologies = [];

        let self = this;
        this.coordinator = new coord.TopologyCoordinator(name, storage, {
            startTopology: (uuid: string, config: any, callback: intf.SimpleCallback) => {
                log.logger().important(self.log_prefix + "Received start instruction from coordinator: " + uuid);
                self.start(uuid, config);
                callback();
            },
            resolveTopologyMismatches: (uuids: string[], callback: intf.SimpleCallback) => {
                self.resolveTopologyMismatches(uuids, callback);
            },
            stopTopology: (uuid: string, callback: intf.SimpleCallback) => {
                self.shutDownTopology(uuid, false, callback);
            },
            killTopology: (uuid: string, callback: intf.SimpleCallback) => {
                self.shutDownTopology(uuid, true, callback);
            },
            shutdown: () => {
                log.logger().important(this.log_prefix + `Received shutdown instruction from coordinator in worker (pid ${process.pid})`);
                if (!self.waiting_for_shutdown) {
                    self.waiting_for_shutdown = true;
                    log.logger().important(this.log_prefix + "Starting graceful worker shutdown...");
                    self.shutdown(() => {
                        log.logger().important(this.log_prefix + "Exiting with code 0");
                        self.exit(0);
                    });
                };
            }
        });

        process.on('uncaughtException', (err) => {
            log.logger().error(this.log_prefix + `Unhandled exception in topology worker (pid ${process.pid})`);
            log.logger().exception(err);
            if (!self.waiting_for_shutdown) {
                self.waiting_for_shutdown = true;
                log.logger().warn(this.log_prefix + "Worker shutting down gracefully");
                self.shutdown(() => {
                    log.logger().warn(this.log_prefix + "Exiting with code 1");
                    self.exit(1);
                });
            }
        });
        let common_shutdown = () => {
            if (!self.waiting_for_shutdown) {
                self.waiting_for_shutdown = true;
                log.logger().important(this.log_prefix + `Received SIGINT or SIGTERM signal in worker (pid ${process.pid})`);
                log.logger().important(this.log_prefix + "Starting graceful worker shutdown...");
                self.shutdown(() => {
                    log.logger().important(this.log_prefix + "Exiting with code 0");
                    self.exit(0);
                });
            }
        };
        process.once('SIGINT', common_shutdown);
        process.once('SIGTERM', common_shutdown);
    }

    /** Internal wrapper around process.exit */
    private exit(code: number) {
        // TODO check process tree and make sure that everything is really shutdown
        process.exit(code);
    }

    /** Starts this worker */
    run(): void {
        this.coordinator.run();
    }

    /** This method verifies that all topologies are running and properly registered */
    private resolveTopologyMismatches(uuids: string[], callback: intf.SimpleCallback): void {
        let self = this;
        if (self.waiting_for_shutdown) {
            return callback();
        }
        async.series(
            [
                (xcallback) => {
                    // topologies that are running,
                    // but are NOT included in the external list,
                    // must be KILLED
                    let to_kill = self.topologies
                        .filter(top => !uuids.includes(top.uuid))
                        .map(top => top.uuid);
                    async.each(
                        to_kill,
                        (uuid: string, xxcallback) => {
                            log.logger().warn(this.log_prefix + "Topology is running but it NOT assigned to this worker, will be KILLED: " + uuid);
                            self.shutDownTopology(uuid, true, xxcallback);
                        },
                        xcallback);
                },
                (xcallback) => {
                    // topologies that are NOT running,
                    // but are included in the external list,
                    // must be reported as unassigned
                    let to_unassign = uuids.filter(uuid => !self.hasTopology(uuid));
                    async.each(
                        to_unassign,
                        (uuid, xxcallback) => {
                            log.logger().warn(this.log_prefix + "Topology is assigned to this worker, but it is not running here will be unassigned: " + uuid);
                            self.coordinator.reportTopology(uuid, intf.Consts.TopologyStatus.unassigned, "", xxcallback);
                        },
                        xcallback);
                }
            ],
            callback
        );
    }

    /** Internal method ensures that a topology exits. */
    private ensureExit(rec: TopologyItem, err?: Error): void {
        if (rec.proxy && !rec.proxy.hasExited()) {
            if (err) {
                log.logger().error(this.log_prefix + "THIS SHOULD NOT HAPPEN. Child process " +
                    "encountered a critical error but did not exit. KILLING child process.");
                log.logger().exception(err);
            } else {
                log.logger().error(this.log_prefix + "THIS SHOULD NOT HAPPEN. Child process " +
                "should have exited. KILLING child process.");
            }
            rec.proxy.kill(() => { });
        }
    }

    /** Internal method that creates proxy for given topology item */
    private createInitAndRunProxy(rec: TopologyItem): void {
        let self = this;
        rec.proxy = new tlp.TopologyLocalProxy((err) => {
            self.ensureExit(rec, err);
            if (err) {
                self.removeAndReportError(rec, err); // on exit with error
            } else {
                self.removeTopology(rec.uuid); // on normal exit
            }
        });
        // report topology as running, then try to start it.
        // we do this because we don't know how long this initialization will take and we could run into trouble with leader.
        self.coordinator.reportTopology(rec.uuid, intf.Consts.TopologyStatus.running, ""); // TODO: why no callback?

        // rec will be added to this.topologies shortly after this call
        // and berfore init and run CALLBACKS are executed.
        rec.proxy.init(rec.uuid, rec.config, (err) => {
            if (err) {
                // Three types of errors possible:
                // - already initialized (NOT exit) -> this should not be possible
                //   since we created a new proxy and called init once.
                // - compile error (exit)
                // - internal init error (exit)
                self.ensureExit(rec, err);
                self.removeAndReportError(rec, err);
            } else {
                self.coordinator.reportTopologyPid(rec.uuid, rec.proxy.getPid());
                rec.proxy.run((err) => {
                    if (err) {
                        // Two types of errors possible:
                        // - already running (NOT exit) -> this should not be possible
                        //   since we created a new proxy and called init and run once.
                        // - running non-initialized (NOT exit) -> this should not be possible
                        //   since we created a new proxy and called init successfully
                        self.ensureExit(rec, err);
                        self.removeAndReportError(rec, err);
                    }
                });
            }
        });
    }

    /** Starts single topology.
     * Guards itself from duplicated calls.
     */
    private start(uuid: string, config: any) {
        let self = this;
        if (self.hasTopology(uuid)) {
            log.logger().warn(self.log_prefix + `Topology with uuid ${uuid} is already running on this worker`);
            return;
        }
        try {
            self.injectOverrides(config);

            let compiler = new comp.TopologyCompiler(config);
            compiler.compile();
            config = compiler.getWholeConfig();

            let rec = new TopologyItem();
            rec.uuid = uuid;
            rec.config = config;
            self.createInitAndRunProxy(rec);

            // only change internal state when all other steps passed
            self.topologies.push(rec);
        } catch (err) {
            log.logger().error(this.log_prefix + "Error while creating topology proxy for " + uuid);
            log.logger().exception(err);
            self.coordinator.reportTopology(uuid, intf.Consts.TopologyStatus.error, "" + err, () => { });
        }
    }

    private hasTopology(uuid: string) {
        return this.topologies.find(top => top.uuid == uuid) != undefined;
    }

    /** This method injects override values into variables section of the configuration. */
    private injectOverrides(config: any) {
        config.variables = config.variables || {};
        for (let f in this.overrides) {
            if (this.overrides.hasOwnProperty(f)) {
                config.variables[f] = this.overrides[f];
            }
        }
    }

    /** Remove specified topology from internal list */
    private removeTopology(uuid: string) {
        let top = this.topologies.find(x => x.uuid == uuid);
        if (top) { this.ensureExit(top); }
        this.topologies = this.topologies.filter(x => x.uuid != uuid);
    }

    /** Shuts down the worker and all its subprocesses. */
    shutdown(callback: intf.SimpleCallback) {
        let self = this;
        async.series(
            [
                (xcallback) => {
                    // preShutdown will swallow exceptions
                    self.coordinator.preShutdown(xcallback);
                },
                (xcallback) => {
                    // shutDownTopologies will return the first
                    // encountered exception which will be swallowed
                    // here.
                    self.shutDownTopologies((err) => {
                        if (err) {
                            log.logger().error(self.log_prefix + "Error while shutting down topologies:");
                            log.logger().exception(err);
                        }
                        xcallback();
                    });
                },
                (xcallback) => {
                    // may pass an exception.
                    self.coordinator.shutdown(xcallback);
                }
            ],
            callback
        );
    }

    /** Sends shutdown signals to all topologies. Will try to shutdown
     * all topologies and if any of them failed, return the first error.
     */
    private shutDownTopologies(callback: intf.SimpleCallback) {
        let self = this;
        let first_err: Error = null;
        async.each(
            self.topologies,
            (item: TopologyItem, xcallback) => {
                self.shutDownTopologyInternal(item, false, (err) => {
                    if (err) {
                        log.logger().error(self.log_prefix + "Error while shutting down topology: " + item.uuid);
                        log.logger().exception(err);
                    }
                    first_err = first_err || err;
                    xcallback(null);
                });
            },
            () => {
                callback(first_err);
            }
        );
    }

    /** Sends shut down signal to single topology */
    private shutDownTopology(uuid: string, do_kill: boolean, callback: intf.SimpleCallback) {
        let self = this;
        let top = self.topologies.find(top => top.uuid == uuid);
        if (top) {
            self.shutDownTopologyInternal(top, do_kill, callback);
        } else {
            // TODO: error, cannot shutdown topology that is not running?
            callback();
        }
    }

    /** Internal method that contains common steps for kill and shutdown sequence */
    private shutDownTopologyInternal(item: TopologyItem, do_kill: boolean, callback: intf.SimpleCallback) {
        let self = this;
        async.series(
            [
                (xcallback) => {
                    if (do_kill) {
                        item.proxy.kill(xcallback);
                    } else {
                        item.proxy.shutdown(xcallback);
                    }
                }
            ],
            (err) => {
                if (err) {
                    log.logger().error(self.log_prefix + "Error while shutting down topology " + item.uuid);
                    log.logger().exception(err);
                    self.coordinator.reportTopology(item.uuid, intf.Consts.TopologyStatus.error, "" + err, callback);
                } else {
                    log.logger().debug(self.log_prefix + "setting topology as unassigned: " + item.uuid);
                    self.coordinator.reportTopology(item.uuid, intf.Consts.TopologyStatus.unassigned, "", callback);
                }
            }
        );
    }

    /** Remove given topology from internal list and report an error */
    private removeAndReportError(rec: TopologyItem, err: Error) {
        this.removeTopology(rec.uuid);
        this.coordinator.reportTopology(rec.uuid, intf.Consts.TopologyStatus.error, "" + err);
    }
}
