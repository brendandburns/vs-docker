# vs-docker README

This is a simple Visual Studio Code extension that knows how to interact with the Docker daemon to
build and run Docker files.

If you open a folder with a Dockerfile in the top level directory, the extension will be activated.

## Features

Currently the extension provides four commands:
   * Docker Build - Builds the Docker image from the Dockerfile.  The name that it gives the image is the
    name of the top-level directory.  For example if you have opened the directory `/home/user/my-project`,
    the name of the image will be `my-project`.
   * Docker Run - Runs the image that is built for the current project.
   * Docker Find - Finds any running containers for the project.
   * Docker Stop - Stops the container that is running for this project.

## Requirements

You need to have the Docker daemon installed and working for your user (e.g. `docker ps` needs to work)

## Extension Settings
All settings can be set globally or in a specific workspace, though most
settings only make sense in the context of a workspace.

### Global settings

   * `vsdocker.registry`: The registry for images that are built. Default is Docker Hub.

### Workspace settings
   * `vsdocker.registry`: The registry for images that are built. Default is Docker Hub.
   * `vsdocker.imageName`: The name of the image to build/run/push. Default is the current root directory for the workspace.
   * `vsdocker.imageVersion`: The version of the image to build/run/push. Default is the current git commit (+ `-dirty` if there are uncommited changes).  If
the workspace is not under git, then `latest` is used.

## Known Issues

Still alpha and incomplete, please file bugs and feature requests!

## Release Notes

### 0.0.1

Initial release of vs-docker

**Enjoy!**
