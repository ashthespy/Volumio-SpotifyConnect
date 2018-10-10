#	Volumio Spotify Connect

This Volumio plugin utilises [`vollibrespot`](https://github.com/ashthespy/vollibrespot)
to provide better integration of Spotify Connect in Volumio.

As always, it is being actively developed - some features are still WIP.

![Alt text](volspotconnect2.jpg?raw=true "Spotify/volumio playing through volspotconnect2")

Tested on :
- RPI 0
- RPI B
- RPI B+
- RPI2
- RPI3
- SPARKY
- PINE64
- x86 laptop
- OrangePiLite

This repo splits the old `volspotconnect2` plugin into a new separate repository, making it easier to maintain.

## IMPORTANT

- Requires a Premium or Family account

## To install
Before installing the dev version, REMOVE the old plugin from your system using the webUI plugins page.

Due to a [Volumio decision](https://volumio.org/forum/require-plugins-uploaded-plugins-repo-t8116-10.html), developer plugins can only be install through SSH. Here is how:

### 1. Enable SSH and connect to Volumio

Follow the [Volumio guide](https://volumio.github.io/docs/User_Manual/SSH.html) to enable and access your device via ssh.

### 2. Download and install the plugin

Type the following commands to download and install plugin:

```
wget https://github.com/balbuze/volumio-plugins/raw/master/plugins/music_service/volspotconnect2/volspotconnect2.zip
mkdir ./volspotconnect2
miniunzip volspotconnect2.zip -d ./volspotconnect2
cd ./volspotconnect2
volumio plugin install
```

### 3.Enable the plugin

In Volumio webUI, go in plugin section > installed plugin. You should see volspotconnect2 now! Enable it and play! You can go in the plugin settings to tweak some details.
Enjoy !


## Issues

- `librespot` doesn't handle disconnections gracefully
