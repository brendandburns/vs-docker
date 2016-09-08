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

function buildImage(name, dir) {
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
                        } catch (ex) {
                            console.log(chunk);    
                        }
                        if (obj.errorDetail) {
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
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;

function getRegistry() {
    return vscode.workspace.getConfiguration().get("vsdocker.registry", null);
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

    var result = shelljs.exec('git log --pretty=format:\'%h\' -n 1');
    if (result.code != 0) {
        vscode.window.showErrorMessage('git log returned: ' + result.code);
        return 'error';
    }
    version = result.stdout;

    result = shelljs.exec('git status --porcelain', { cwd: vscode.workspace.rootPath});
    if (result.code != 0) {
        vscode.window.showErrorMessage('git status returned: ' + result.code);
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

function vsDockerBuild(fn) {
    var name = findImageName();
    vscode.window.showInformationMessage("Starting to build " + name);
    buildImage(name, vscode.workspace.rootPath).then(function (success, obj) {
        if (success) {
            vscode.window.showInformationMessage("Build succeeded");
            if (fn) {
                fn();
            }
        } else if (obj && obj.errorDetail) {
            vscode.window.showErrorMessage("Build failed: " + obj.errorDetail.message);
        } else {
            vscode.window.showErrorMessage("A build error occurred");
        }
    });
};

function vsDockerRun() {
    var name = findImageName();
    var dockerFilePath = path.join(vscode.workspace.rootPath, "Dockerfile");
    var dockerFileData = fs.readFileSync(dockerFilePath).toString();
    console.log(dockerFileData);
    var dockerFileObj = dockerparse(dockerFileData);

    findContainer(name).then(function(container) {
        if (container) {
            vscode.window.showWarningMessage("A container is already running. Do you wish to restart?", "Restart").then(
                function(msg) {
                    if (msg == "Restart") {
                        client().getContainer(container.Id).stop(function(err, data) {
                            if (err) {
                                vscode.window.showErrorMessage("Failed to stop container: " + err);
                                return;
                            }
                            vsDockerBuild(function() {
                                runImageWithNotifications(name, dockerFileObj.expose);
                            });
                        });
                    }
                });
            return;
        }
        vsDockerBuild(function() {
            runImageWithNotifications(name, dockerFileObj.expose);
        });
    });
};

function runImageWithNotifications(name, ports) {
    runImage(name, ports).then(function(success, obj) {
        if (success) {
            vscode.window.showInformationMessage("Container running.");
        } else {
            vscode.window.showErrorMessage("Failed to run container: " + obj);
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
            vscode.window.showInformationMessage("Found container: " + container.Id);
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
                        console.log(info);
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
                    vscode.window.showErrorMessage("Failed to delete container: " + err);
                } else {
                    vscode.window.showInformationMessage("Container stopped.");
                }
            });
        }
    });
};

function vsDockerPush() {
    vscode.window.showInformationMessage('Starting image push...');
    var name = findImageName();
    shelljs.exec('docker push ' + name, function(result, stdout, stderr) {
        if (result != 0) {
            vscode.window.showErrorMessage('Docker push failed: ' + stderr);
            console.log(stderr);
        } else {
            vscode.window.showInformationMessage('Image ' + name + ' pushed successfully.');
        }
    });
}

// This doesn't quite work...
function vsDockerPushNative() {
    var authconfig = vscode.workspace.getConfiguration().get('vsdocker.authconfig');
    var auth = null;
    if (!authconfig) {
        vscode.window.showWarningMessage('vsdocker.authconfig setting is undefined, this push will be unauthenticated.');
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
            vscode.window.showErrorMessage('Failed to push image: ' + err);
            return;
        }
        var status = true;
        output.on('data', function (chunk) {
            obj = JSON.parse(chunk);
            if (obj.errorDetail) {
                status = false;
                vscode.window.showErrorMessage('Image push failed: ' + obj.errorDetail.message);
            }
        });
        // TODO: handle 'errorDetail messages here?'
        output.on('end', function() {
            if (status) {
                vscode.window.showInformationMessage('Successfully pushed image ' + name);
            }
        });
    },
    auth);
}