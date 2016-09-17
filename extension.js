// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode');
var path = require('path');
var fs = require('fs');
var shelljs = require('shelljs');

var dockerClientLib = null;
var client = function () {
    if (dockerClientLib == null) {
        var docker = require('dockerode');
        dockerClientLib = new docker({
            //socketPath: '/var/run/docker.sock'
            host: '127.0.0.1',
            port: 2375
        });
    }
    return dockerClientLib;
}

var tarLib = null;
var tar = function () {
    if (tarLib == null) {
        tarLib = require('tar-fs');
    }
    return tarLib;
}

var dockerparse = require('dockerfile-parse');

var stream = require('stream');

function buildImage(name, dir, outputFn) {
    return {
        'then': function (fn) {
            var tarStream = tar().pack(dir);
            client().buildImage(tarStream, {
                't': name
            }, function (err, output) {
                if (err) {
                    fn(false, null);
                } else {
                    var status = true;
                    var obj = null;
                    output.on('data', function (chunk) {
                        try {
                            obj = JSON.parse(chunk);
                            if (outputFn) {
                                outputFn(obj.stream.toString());
                            }
                        } catch (ex) {
                            console.log(ex);
                            console.log(chunk.toString());    
                        }
                        if (obj && obj.errorDetail) {
                            status = false;
                        }
                    });
                    output.on('error', function () {
                        status = false;
                    })
                    output.on('end', function () {
                        fn(status, obj);
                    });
                }
            });
        }
    };
};

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {
    var disposable = vscode.commands.registerCommand('extension.vsDockerBuild', vsDockerBuild);
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.vsDockerRun', vsDockerRun);
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.vsDockerFind', vsDockerFind);
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.vsDockerKill', vsDockerKill);
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.vsDockerPush', vsDockerPush);
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.vsDockerLogs', vsDockerLogs);
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('extension.vsDockerExec', vsDockerExec);
    context.subscriptions.push(disposable);

    vscode.workspace.onDidSaveTextDocument((event) => {
        var autorun = vscode.workspace.getConfiguration().get("vsdocker.autorun", "true");
        if (autorun && autorun == "true") {
            vsDockerRun(null, {
                silent: true,
                autorun: true
            });
        } else {
            vsDockerBuild(null, { silent: true });
        }
    });
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;

function getRegistry() {
    return vscode.workspace.getConfiguration().get("vsdocker.registry", null);
}

function log(fn, str, ...items) {
    var args = items[0];
    if (args && args.length > 0) {
        console.log(args);
        return fn(str, ...args);
    }
    return fn(str);    
}

function info(str, ...items) {
    return log(vscode.window.showInformationMessage, str, items);    
}

function warn(str, ...items) {
    return log(vscode.window.showWarningMessage, str, items);
}

function error(str, ...items) {
    return log(vscode.window.showErrorMessage, str, items);
}

function findBaseName() {
    var config = vscode.workspace.getConfiguration();
    var image = config.get("vsdocker.imageName", null);
    if (!image) {
        image = path.basename(vscode.workspace.rootPath);
    }
    var user = config.get("vsdocker.imageUser", null);
    if (user) {
        image = user + '/' + image;
    }
    var registry = getRegistry();
    if (registry) {
        image = registry + "/" + image;
    }
    return image;
}

function findVersion() {
    // User supplied override
    var version = vscode.workspace.getConfiguration().get("vsdocker.imageVersion", null);
    if (version) {
        return version;
    }
    // No .git dir, use 'latest'
    // TODO: use 'git rev-parse' to detect upstream directories
    if (!fs.existsSync(path.join(vscode.workspace.rootPath, ".git"))) {
        return 'latest';
    }

    var result = shelljs.exec('git log --pretty=format:\'%h\' -n 1', {
        'cwd': vscode.workspace.rootPath
    });
    var result = shelljs.exec('git rev-parse HEAD')
    if (result.code != 0) {
        error('git log returned: ' + result.code + ' ' + result.stdout);
        return 'error';
    }
    version = result.stdout;

    result = shelljs.exec('git status --porcelain', { cwd: vscode.workspace.rootPath});
    if (result.code != 0) {
        error('git status returned: ' + result.code);
        return 'error';
    }
    if (result.stdout != '') {
        version += '-dirty';
    }
    return version;
}

function findImageName() {
    return findBaseName() + ':' + findVersion();
}

function vsDockerBuild(fn, opts) {
    var name = findImageName();
    if (!opts) {
        opts = {};
    }
    if (!opts.silent) {
        info("Starting to build " + name);
    }

    var channelName = "Container Build";
    if (!opts.silent) {
        out(channelName).clear();
        out(channelName).show();
    }
    buildImage(name, vscode.workspace.rootPath, function(str) {
        if (!opts.silent) {
            out(channelName).append(str);
        }
    }).then(function (success, obj) {
        if (success) {
            if (!opts.silent) {
                info("Build succeeded");
            }
            if (fn) {
                fn();
            }
        } else if (obj && obj.errorDetail) {
            error("Build failed: " + obj.errorDetail.message);
        } else {
            error("A build error occurred");
        }
    });
};

function restartAndBuild(name, container, ports, callback, opts) {
    client().getContainer(container.Id).stop(function(err, data) {
        if (err) {
            error("Failed to stop container: " + err);
            return;
        }
        vsDockerBuild(function() {
            runImageWithNotifications(name, ports, callback, opts);
        }, opts);
    });
}

function vsDockerRun(callback, opts) {
    var name = findImageName();
    var dockerFilePath = path.join(vscode.workspace.rootPath, "Dockerfile");
    var dockerFileData = fs.readFileSync(dockerFilePath).toString();
    var dockerFileObj = dockerparse(dockerFileData);
    if (!opts) {
        opts = {};
    }
    findContainer(name).then(function(container) {
        if (container) {
            if (opts.autorun) {
                restartAndBuild(name, container, dockerFileObj.expose, callback, opts);
            } else {
                warn("A container is already running. Do you wish to restart?", "Restart").then(
                    function(msg) {
                        if (msg == "Restart") {
                            restartAndBuild(name, container, dockerFileObj.expose, callback, opts);
                        }
                    });
                return;
            }
        } else {
            vsDockerBuild(function() {
                runImageWithNotifications(name, dockerFileObj.expose, callback, opts);
            }, opts);
        }
    });
};

function runImageWithNotifications(name, ports, callback, opts) {
    runImage(name, ports).then(function(success, obj) {
        if (success) {
            if (!opts.silent) {
                info("Container running.");
            }
            vsDockerLogs(opts);
        } else {
            error("Failed to run container: " + obj);
        }
        if (callback) {
            callback();
        }
    });
};

function runImage(name, ports) {
    var exposed = {};
    var bindings = {};

    if (ports) {
        ports.forEach(function(port) {
            var portStr = port + "";
            var fullPort = portStr + "/tcp";
            exposed[fullPort] = {};
            bindings[fullPort] = [{ "HostPort": portStr}];
        });
    }

    return {
        'then': function(fn) {
            client().createContainer({
                Image: name,
                ExposedPorts: exposed,
                HostConfig: {
                    "PortBindings": bindings
                }
            }, function (err, container) {
                if (err) {
                    fn(false, err);
                } else {
                    container.start(function (err, data) {
                        if (err) {
                            fn(false, err);
                        } else {
                            fn(true, data);
                        }
                    });
                }
            });
        }
    };
};

function vsDockerFind() {
    var name = findImageName();
    findContainer(name).then(function(container) {
        if (container) {
            info("Found container: " + container.Id);
        }
    })
};

function findContainer(name) {
    return {
        'then': function(fn) {
            client().listContainers(function (err, containers) {
                var result = null;
                if (containers != null) {
                    containers.forEach(function (info) {
                        if (info.Image == name) {
                            result = info;
                        }
                    });
                }
                fn(result);
            });
        }
    };
};

function vsDockerKill() {
    var name = findImageName();
    findContainer(name).then(function(container) {
        if (container) {
            client().getContainer(container.Id).stop(function(err, data) {
                if (err) {
                    error("Failed to delete container: " + err);
                } else {
                    info("Container stopped.");
                }
            });
        }
    });
};

function vsDockerPush() {
    info('Starting image push...');
    var name = findImageName();
    shelljs.exec('docker push ' + name, function(result, stdout, stderr) {
        if (result != 0) {
            error('Docker push failed: ' + stderr);
            console.log(stderr);
        } else {
            info('Image ' + name + ' pushed successfully.');
            out("Container Push").append(stdout);
        }
    });
}

// This doesn't quite work...
function vsDockerPushNative() {
    var authconfig = vscode.workspace.getConfiguration().get('vsdocker.authconfig');
    var auth = null;
    if (!authconfig) {
        warn('vsdocker.authconfig setting is undefined, this push will be unauthenticated.');
    } else {
        auth = JSON.parse(fs.readFileSync(authconfig));
    }

    var registry = getRegistry();
    if (!registry) {
        registry = 'index.docker.io:5000';
    }
    var name = findImageName();
    var img = client().getImage(name);
    img.push({
        'registry': registry
    },
    function(err, output) {
        if (err) {
            error('Failed to push image: ' + err);
            return;
        }
        var status = true;
        output.on('data', function (chunk) {
            obj = JSON.parse(chunk);
            if (obj.errorDetail) {
                status = false;
                error('Image push failed: ' + obj.errorDetail.message);
            }
        });
        // TODO: handle 'errorDetail messages here?'
        output.on('end', function() {
            if (status) {
                info('Successfully pushed image ' + name);
            }
        });
    },
    auth);
}

var outChannels = {};
function out(name) {
    if (outChannels[name] == null) {
        outChannels[name] = vscode.window.createOutputChannel(name);
    }
    return outChannels[name];
}

function vsDockerLogs(opts) {
    var channelName = "Container Logs";
    out(channelName).clear();
    if (!opts.silent) {
        out(channelName).show();
    }
    // create a single stream for stdin and stdout
    var logStream = new stream.PassThrough();
    logStream.on('data', function(chunk){
        out(channelName).append(chunk.toString());
    });

    var name = findImageName();
    findContainer(name).then(function(cObj) {
        if (cObj == null) {
            // We should list all containers (even not running) and logs any stopped containers
            error("Couldn't find a container!");
        }
        var container = client().getContainer(cObj.Id);
        container.logs({
            follow: true,
            stdout: true,
            stderr: true
        }, function(err, stream){
            if(err) {
                out(channelName).append(err.message);
                return;
            }
            container.modem.demuxStream(stream, logStream, logStream);
            stream.on('end', function(){
                logStream.end('!stop!');
            });
        });
    });
}

function vsDockerExec() {
    withContainer(execInternal);
}

function withContainer(callback) {
    var name = findImageName();
    findContainer(name).then(function(container) {
        if (!container) {
            warn("A container is not currently running. Do you wish to start?", "Start").then(
                function(msg) {
                    if (msg == "Start") {
                        vsDockerRun(function() {
                            findContainer(name).then(function(container) {
                                callback(container.Id);
                            })
                        });
                    }
                });
        } else {
            callback(container.Id);
        }
    });
}

function execInternal(id) {
    vscode.window.showInputBox({
        placeHolder: "Please provide a command",
        prompt: "Exec"
    }).then(function(cmd) {
        var term = vscode.window.createTerminal();
        term.sendText("docker exec -it " + id + " " + cmd);
        term.show(false);
    });
}
