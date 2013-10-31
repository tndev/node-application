var fs = require('fs');
var path = require('path');
var ansi = require('ansi'),
    cursor = ansi(process.stdout);
var when = require('when');
var cp = require('child_process');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var App = function() {
    var appName = path.basename(process.argv[1], ".js");

    this._exitCallbacks = [];
    this._runCallbacks = [];
    this._reloadCallbacks = [];

    process.title = appName;
    this.argv = require('optimist')
        .usage('$0')
        .default ('pid', "/tmp/" + process.title + ".pid")
        .argv;

    /*
	 need to add support for custom options
	 somehow via constructor or config file !!11!!!!11
	 */
    this._pidPath = this.argv.pid;

};

util.inherits(App, EventEmitter);


App.prototype._createPid = function(force) {
    try {
        var pid = new Buffer(process.pid + '\n'),
            fd = fs.openSync(this._pidPath, force ? 'w' : 'wx'),
            offset = 0;

        while (offset < pid.length) {
            offset += fs.writeSync(fd, pid, offset, pid.length - offset);
        }

        fs.closeSync(fd);
    } catch (e) {
        if (e.code === 'EACCES') {
            throw new Error("could not create pid file");
        } else if (e.code === 'EEXIST') {
            throw new Error("process already running");
        }
    }

    process.on('exit', this._clearPidFile.bind(this));
};

App.prototype._clearPidFile = function() {
    console.log("exit");
    fs.unlinkSync(this._pidPath);
};

App.prototype.exec = function() {

    if (this.argv._.length > 0) {
        if (this.argv._[0] == 'start') {
            this.startDaemon();
        } else if (this.argv._[0] == 'stop') {
            this.stopDaemon();
        } else if (this.argv._[0] == 'reload') {
            this.reloadDaemon();
        } else if (this.argv._[0] == 'restart') {
            when(this.stopDaemon())
                .then((function() {
                this.startDaemon();
            }).bind(this));
        } else {
            this._run();
        }
    } else {
        this._run();
    }
};

App.prototype.exit = function(callback) {
    this._exitCallbacks.push(callback);
};

App.prototype._sigTerm = function() {
    var defers = [];
    this._exitCallbacks.forEach(function(cb) {
        defers.push(cb(this));
    });

    when.all(defers)
        .then(function() {
        process.exit(0);
    });
};


App.prototype._sigHup = function() {
    var defers = [];
    this._reloadCallbacks.forEach(function(cb) {
        defers.push(cb(this));
    });

    when.all(defers)
        .then((function() {
        var time = (new Date()).getTime() / 1000;
        fs.utimes(this._pidPath, time, time);
    }).bind(this));

};

App.prototype._sigInt = function() {
    process.exit(0);
};

App.prototype.reload = function(callback) {
    this._reloadCallbacks.push(callback);
}

App.prototype.run = function(callback) {
    this._runCallbacks.push(callback);
};

App.prototype._run = function() {

    var defers = [];
    this._runCallbacks.forEach(function(cb) {
        defers.push(cb(this));
    });

    //wait for all startup callbacks
    when.all(defers)
        .then((function(value) {
        //register the signal listners
        process.on("SIGTERM", this._sigTerm.bind(this));
        process.on("SIGHUP", this._sigHup.bind(this));
        process.on("SIGINT", this._sigInt.bind(this));

        //create the pid when we are finished
        this._createPid();
    }).bind(this));

};

App.prototype.startDaemon = function() {
    //TODO we require a lock file here for the checking !!!!
    cursor.fg.reset().write('Starting ' + process.title + ' ... ');

    this._getPid((function(err, pid) {
        if (err) {
            try {
                var outS = fs.openSync('./out.log', 'a');
                var errS = fs.openSync('./err.log', 'a');
                cp.spawn(process.execPath, [process.argv[1]], {
                    detached: true,
                    stdio: ['ignore', outS, errS],
                    env: process.env,
                    cwd: process.cwd
                });


                var checkStarting = (function() {
                    fs.exists(this._pidPath, function(exists) {
                        if (!exists) {
                            setImmediate(checkStarting);
                        } else {
                            cursor.green().bold().write('done\n').reset();
                            process.exit(0);
                        }
                    });
                }).bind(this);
                checkStarting();

            } catch (e) {
                cursor.red().bold().write('fail (' + e + ')\n').reset();
            }

        } else {
            cursor.yellow().bold().write('already running: ' + parseInt(pid) + '\n').reset();
        }
    }).bind(this));

};


App.prototype.stopDaemon = function() {
    var d = when.defer();

    cursor.fg.reset().write('Stopping ' + process.title + ' ... ');

    //check if pid file exists
    this._getPid((function(err, pid) {
        if (err) {
            //there is no pid file, so app is not running anmyore
            cursor.yellow().bold().write('not running\n').reset();
            d.resolve();
        } else {

            try {
                process.kill(pid, "SIGTERM");

                var checkStopping = (function() {
                    fs.exists(this._pidPath, function(exists) {
                        if (exists) {
                            setImmediate(checkStopping);
                        } else {
                            cursor.green().bold().write('done\n').reset();
                            d.resolve();
                        }
                    });
                }).bind(this);
                checkStopping();

            } catch (e) {
                if (e.errno == 'EPERM') {

                    cursor.red().bold().write('insufficient rights\n').reset();
                    d.reject();
                } else {
                    cursor.yellow().bold().write('not running\n').reset();
                    fs.unlink(this._pidPath);
                    d.reject();
                }
            }

        }
    }).bind(this));

    return d.promise;
};


App.prototype.reloadDaemon = function() {
    //TODO we require a lock file here for the checking !!!!
    cursor.fg.reset().write('Reload ' + process.title + ' ... ');
    this._getPid((function(err, pid) {
        if (err) {
            cursor.red().bold().write('fail (not running)\n').reset();
        } else {
            //need to check if we are don

            var mtime = fs.statSync(this._pidPath).mtime;

            try {
                process.kill(pid, "SIGHUP");
                var checkRestart = (function() {
                    var mtimeNow = fs.statSync(this._pidPath).mtime;

                    if (mtimeNow.getTime() == mtime.getTime()) {
                        setImmediate(checkRestart);
                    } else {
                        cursor.green().bold().write('done\n').reset();
                    }
                }).bind(this);
                checkRestart();
            } catch (e) {
                cursor.red().bold().write('insufficient rights\n').reset();
            }

        }
    }).bind(this));
};

App.prototype._getPid = function(callback) {
    var path = this._pidPath;
    fs.exists(path, function(exists) {
        if (exists) {
            fs.readFile(path, function(err, data) {
                if (err) {
                    callback("error while reading");
                } else {
                    callback(null, data);
                }
            });
        } else {
            callback("not pid exists");
        }
    });
};



exports.App = App;
exports.createApp = function() {
    return new App();
};