import * as cp from "child_process";

/** Simple interface that defined standard callback */
export interface SimpleCallbackChildProcRestarter {
    (error?: Error): void;
}

/** This utility method outputs data to console, clipping training new-line if present. */
function outputToConsole(data) {
    let s = data.toString() as string;
    if (s.length > 0 && s.endsWith("\n")) {
        s = s.substring(0, s.length - 1);
    }
    console.log(s);
}

/** Simple class that starts child process, monitors it
 * and restarts it when it exits.
 */
export class ChildProcRestarterInner {

    private cmd: string;
    private cmd_line_args: string[];
    private cwd: string;
    private use_fork: boolean;
    private proc: cp.ChildProcess;
    private paused: boolean;
    private pending_exit_cb: SimpleCallbackChildProcRestarter;

    /** Simple constructor */
    constructor(cmd: string, args: string[], cwd: string, use_fork: boolean) {
        this.cmd = cmd;
        this.cmd_line_args = args;
        this.cwd = cwd;
        this.use_fork = use_fork;
        this.paused = true;
    }

    /** Internal method for starting the child process */
    private _start() {
        let self = this;
        if (this.proc) {
            return;
        }
        if (this.paused) {
            return;
        }
        if (this.use_fork) {
            let options = {} as cp.ForkOptions;
            options.silent = false;
            if (this.cwd) {
                options.cwd = this.cwd;
            }
            this.proc = cp.fork(this.cmd, this.cmd_line_args, options);
        } else {
            let options = {} as cp.SpawnOptions;
            if (this.cwd) {
                options.cwd = this.cwd;
            }
            this.proc = cp.spawn(this.cmd, this.cmd_line_args, options);
            this.proc.stdout.on("data", outputToConsole);
            this.proc.stderr.on("data", outputToConsole);
        }
        this.proc.on("exit", (code) => {
            delete this.proc;
            self.proc = null;
            if (self.pending_exit_cb) {
                self.pending_exit_cb();
            } else {
                setTimeout(() => {
                    self._start();
                }, 1000);
            }
        });
    }

    /** Starts child process */
    start() {
        this.paused = false;
        this._start();
    }

    /** Stops child process and doesn't restart it. */
    stop(cb: SimpleCallbackChildProcRestarter) {
        this.paused = true;
        this.pending_exit_cb = cb || (() => { });
        if (this.proc) {
            this.proc.kill("SIGINT");
        }
    }
}

/** Simple class that starts child process, monitors it
 * and restarts it when it exits.
 */
export class ChildProcRestarter extends ChildProcRestarterInner {

    /** Simple constructor */
    constructor(cmd: string, args: string[], cwd?: string) {
        super(cmd, args, cwd, false);
    }
}

/** Simple class that starts child process WITH FORK, monitors it
 * and restarts it when it exits.
 */
export class ChildProcRestarterFork extends ChildProcRestarterInner {

    /** Simple constructor */
    constructor(cmd: string, args: string[], cwd?: string) {
        super(cmd, args, cwd, true);
    }
}
