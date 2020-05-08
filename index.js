'use strict';
/* global metrics */
// Core Volumio stuff
const libQ = require('kew');
const Config = require('v-conf');

// NodeJS helpers
const fs = require('fs-extra');
// Or https://nodejs.org/api/fs.html#fs_fs_promises_api
// const { promises: fs } = require("fs");
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const readFile = (fileName) => fs.readFile(fileName, 'utf8');
const writeFile = (fileName, data) => fs.writeFile(fileName, data, 'utf8');
const path = require('path');

// Plugin modules and helpers
const SpotifyWebApi = require('spotify-web-api-node');
const SpotConnCtrl = require('./SpotConnController').SpotConnEvents;
const msgMap = require('./SpotConnController').msgMap;
const logger = require('./logger');
// Global
var seekTimer;

// Define the ControllerVolspotconnect class
module.exports = ControllerVolspotconnect;

function ControllerVolspotconnect (context) {
  var self = this;
  // Save a reference to the parent commandRouter
  self.context = context;
  self.commandRouter = self.context.coreCommand;

  // Volatile for metadata
  self.unsetVol = () => {
    logger.info('unSetVolatile called');
    return this.spotConnUnsetVolatile();
  };

  // SpotifyWebApi
  self.spotifyApi = new SpotifyWebApi();
  self.device = undefined;
}

ControllerVolspotconnect.prototype.onVolumioStart = function () {
  const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new Config();
  this.config.loadFile(configFile);
  /*
  // is this defer still needed?
  var defer = libQ.defer();
  self.createConfigFile()
    .then(function (e) {
      defer.resolve({});
    })
    .fail(function (e) {
      defer.reject(new Error());
    });
*/

  return libQ.resolve();
};

ControllerVolspotconnect.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

// Plugin methods -----------------------------------------------------------------------------

ControllerVolspotconnect.prototype.VolspotconnectServiceCmds = async function (cmd) {
  if (!['start', 'stop', 'restart'].includes(cmd)) {
    throw TypeError('Unknown systemmd command: ', cmd);
  }
  const { stdout, stderr } = await exec(`/usr/bin/sudo /bin/systemctl ${cmd} volspotconnect2.service`, { uid: 1000, gid: 1000 });
  if (stderr) {
    logger.error(`Unable to ${cmd} Daemon: `, stderr);
  } else if (stdout) {}
  logger.info(`Vollibrespot Daemon service ${cmd}ed!`);
};

// For metadata
ControllerVolspotconnect.prototype.volspotconnectDaemonConnect = function (defer) {
  var self = this;
  self.servicename = 'volspotconnect2';
  self.displayname = 'volspotconnect2';
  self.accessToken = '';
  self.active = false;
  self.DeviceActive = false;
  self.SinkActive = false;
  self.VLSStatus = '';
  self.SPDevice = undefined; // WebAPI Device
  self.state = {
    status: 'stop',
    service: 'volspotconnect2',
    title: '',
    artist: '',
    album: '',
    albumart: '/albumart',
    uri: '',
    // icon: 'fa fa-spotify',
    trackType: 'spotify',
    seek: 0,
    duration: 0,
    samplerate: '44.1 KHz',
    bitdepth: '16 bit',
    bitrate: '',
    channels: 2
  };

  const nHost = ''; // blank = localhost
  const nPort = 5030;
  logger.info('Starting metadata listener');
  self.SpotConn = new SpotConnCtrl({
    address: nHost,
    port: nPort
  });
  self.Events = self.SpotConn.Events;
  self.SpotConn.sendmsg(msgMap.get('Hello'));

  // Register callbacks from the daemon
  self.SpotConn.on('error', function (err) {
    logger.error('Error connecting to metadata daemon', err);
    throw Error('Unable to connect to Spotify metadata daemon: ', err);
  });

  self.SpotConn.on(self.Events.DeviceActive, function (data) {
  // A Spotify Connect session has been initiated
    logger.evnt('<DeviceActive> A connect session has begun');
    self.commandRouter.pushToastMessage('info', 'Spotify Connect', 'Session is active!');
    // Do not stop Volumio playback, just notify

    // self.volumioStop().then(() => {
    //   self.state.status = 'pause';
    //   self.ActiveState();
    // });
  });

  self.SpotConn.on(self.Events.PlaybackActive, function (data) {
  // SpotConn is active playback device
  // This is different from SinkActive, it will be triggered at the beginning
  // of a playback session (e.g. Playlist) while the track loads
    logger.evnt('<PlaybackActive> Device palyback is active!');
    self.commandRouter.pushToastMessage('info', 'Spotify Connect', 'Connect is active');
    self.volumioStop().then(() => {
      self.DeviceActive = true;
      // self.state.status = 'play';
      self.ActiveState();
      self.pushState();
    });
  });

  self.SpotConn.on(self.Events.SinkActive, function (data) {
    // Sink is active when actual playback starts
    logger.evnt('<SinkActive> Sink acquired');
    self.SinkActive = true;
    self.checkWebApi();
    self.state.status = 'play';
    if (!self.active) self.ActiveState();
    self.pushState();
  });

  self.SpotConn.on(self.Events.PlaybackInactive, async function (data) {
    logger.evnt('<PlaybackInactive> Device palyback is inactive');
    // Device has finished playing current queue or received a pause command
    //  overkill async, who are we waiting for?
    if (self.VLSStatus === 'pause') {
      logger.warn('Device is paused');
    } else if (!self.active) {
      await self.DeactivateState();
    } else {
      logger.warn(`Device is_active: ${self.active}`);
    }
  });

  self.SpotConn.on(self.Events.SinkInactive, function (data) {
  // Alsa sink has been closed
    logger.evnt('<SinkInactive> Sink released');
    self.SinkActive = false;
    clearInterval(seekTimer);
    seekTimer = undefined;
    self.state.status = 'pause';
    self.commandRouter.servicePushState(self.state, self.servicename);
  });

  self.SpotConn.on(self.Events.DeviceInactive, async function (data) {
  // Connect session has been exited
    await self.DeactivateState();
    logger.evnt('<DeviceInactive> Connect Session has ended');
  });

  self.SpotConn.on(self.Events.Seek, function (position) {
    logger.evnt(`<Seek> ${position}`);
    self.state.seek = position;
    self.pushState();
  });

  self.SpotConn.on(self.Events.Metadata, function (meta) {
    logger.evnt(`<Metadata> ${meta.track_name}`);
    // Update metadata
    const albumartId = meta.albumartId[2] === undefined ? meta.albumartId[0] : meta.albumartId[2];
    self.state.uri = `spotify:track:${meta.track_id}`;
    self.state.title = meta.track_name;
    self.state.artist = meta.artist_name.join(', ');
    self.state.album = meta.album_name;
    self.state.duration = Math.ceil(meta.duration_ms / 1000);
    self.state.seek = meta.position_ms;
    self.state.albumart = `https://i.scdn.co/image/${albumartId}`;
    logger.evnt(`Pushing metadata Vollibrespot: ${self.active}`);
    // This will not succeed if volspotconnect2 isn't the current active service
    self.pushState();
  });

  self.SpotConn.on(self.Events.Token, function (token) {
    // Init WebAPI with token
    logger.evnt(`<Token> ${token.accessToken}`);
    self.accessToken = token.accessToken;
    self.initWebApi();
  });

  self.SpotConn.on(self.Events.Volume, function (spvol) {
    // Listen to volume changes
    logger.evnt(`<Volume> ${spvol}`);
    const vol = Math.round(spvol);
    logger.evnt(`Volume: Spotify:${spvol} Volumio: ${vol}`);
    self.commandRouter.volumioupdatevolume({
      vol: vol,
      mute: false
    });
  });

  self.SpotConn.on(self.Events.Status, function (status) {
    logger.evnt(`<State> ${status}`);
    self.VLSStatus = status;
  });

  self.SpotConn.on(self.Events.Pong, function (type) {
    logger.evnt(`<Pong> ${type}`);
  });

  self.SpotConn.on(self.Events.Unknown, function (msg, err) {
    // logger.evnt('<Unknown>', msg, err);
  });
};

ControllerVolspotconnect.prototype.checkActive = async function () {
  const res = await this.spotifyApi.getMyDevices();
  if (res.statusCode !== 200) {
    logger.debug('getMyDevices: ');
    logger.debug(res);
    return false;
  }
  const activeDevice = res.body.devices.find((el) => el.is_active === true);
  if (activeDevice !== undefined) {
    // This will fail if someone sets a custom name in the template..
    if (this.commandRouter.sharedVars.get('system.name') === activeDevice.name) {
      this.SPDevice = activeDevice;
      logger.info(`Setting VLS device_id: ${activeDevice.id}`);
      this.deviceID = activeDevice.id;
      return true;
    } else {
      this.SPDevice = undefined;
      return false;
    }
  } else {
    logger.warn('No active spotify devices found');
    logger.debug('Devices: ', res.body);
    return false;
  }
};

ControllerVolspotconnect.prototype.initWebApi = function () {
  this.spotifyApi.setAccessToken(this.accessToken);
  if (!this.checkActive()) {
    this.DeactivateState();
  }
};

ControllerVolspotconnect.prototype.checkWebApi = function () {
  if (!this.accessToken || this.accessToken.length === 0) {
    logger.warn('Invalid webAPI token, requesting a new one...');
    this.SpotConn.sendmsg(msgMap.get('ReqToken'));
  }
};

// State updates
ControllerVolspotconnect.prototype.ActiveState = function () {
  this.active = true;
  // Vollibrespot is currently Active (Session|device)!
  logger.info('Vollibrespot Active');
  if (!this.iscurrService()) {
    logger.info('Setting Volatile state to Volspotconnect2');
    this.context.coreCommand.stateMachine.setConsumeUpdateService(undefined);
    this.context.coreCommand.stateMachine.setVolatile({
      service: this.servicename,
      callback: this.unsetVol
    });
  }
  // Push state with metadata
  this.commandRouter.servicePushState(this.state, this.servicename);
};

ControllerVolspotconnect.prototype.DeactivateState = async function () {
  var self = this;
  self.active = false;

  // FIXME: use a differnt check
  // Giving up Volumio State
  return new Promise(resolve => {
    // Some silly race contions again. This should really be refactored!
    // logger.debug(`self.SinkActive  ${self.SinkActive} || self.DeviceActive ${self.DeviceActive}`);
    if (self.SinkActive || self.DeviceActive) {
      self.device === undefined ? logger.info('Relinquishing Volumio State')
        : logger.warn(`Relinquishing Volumio state, Spotify session: ${self.device.is_active}`);
      self.context.coreCommand.stateMachine.unSetVolatile();
      self.context.coreCommand.stateMachine.resetVolumioState().then(() => {
        self.context.coreCommand.volumioStop.bind(self.commandRouter);
        self.DeviceActive = false;
      }
      );
    }
  });
};

ControllerVolspotconnect.prototype.spotConnUnsetVolatile = function () {
  // var self = this;

  // FIXME: use a differnt check
  this.device === undefined ? logger.info('Relinquishing Volumio State to another service')
    : logger.warn(`Relinquishing Volumio state to another service, Spotify session: ${this.device.is_active}`);

  return this.stop();
};

ControllerVolspotconnect.prototype.pushState = function () {
  logger.state(`Pushing new state :: ${this.iscurrService()}`);
  this.seekTimerAction();
  // Push state
  this.commandRouter.servicePushState(this.state, this.servicename);
};

ControllerVolspotconnect.prototype.volumioStop = function () {
  if (!this.iscurrService()) {
    logger.warn('Stopping currently active service');
    return this.commandRouter.volumioStop();
  } else {
    logger.warn('Not requsting volumioStop on our own service');
  }
  return Promise.resolve(true);
};

ControllerVolspotconnect.prototype.iscurrService = function () {
  // Check what is the current Volumio service
  const currentstate = this.commandRouter.volumioGetState();
  logger.info(`Currently active: ${currentstate.service}`);
  if (currentstate !== undefined && currentstate.service !== undefined && currentstate.service !== this.servicename) {
    return false;
  }
  return true;
};

ControllerVolspotconnect.prototype.onStop = function () {
  try {
    this.DeactivateState();
    logger.warn('Stopping Vollibrespot daemon');
    this.VolspotconnectServiceCmds('stop');
    // Close the metadata pipe:
    logger.info('Closing metadata listener');
    this.SpotConn.close();
  } catch (e) {
    logger.error('Error stopping Vollibrespot daemon: ', e);
  }

  //  Again, are these even resolved?
  return libQ.resolve();
};

ControllerVolspotconnect.prototype.onStart = function () {
  const defer = libQ.defer();
  this.init().then(() => defer.resolve());
  return defer.promise;
};

// Workaround for non Promise aware pluginmanger
ControllerVolspotconnect.prototype.init = async function () {
  if (typeof metrics === 'undefined') {
    console.time('SpotifyConnect');
  } else {
    metrics.time('SpotifyConnect');
  }
  try {
    // await creation?
    this.createConfigFile();
    this.volspotconnectDaemonConnect();
    await this.VolspotconnectServiceCmds('start');

    // Hook into Playback config
    // TODO: These are called multiple times, and there is no way to deregister them
    // So be warned...
    this.commandRouter.sharedVars.registerCallback('alsa.outputdevice',
      this.rebuildRestartDaemon.bind(this));
    this.commandRouter.sharedVars.registerCallback('alsa.outputdevicemixer',
      this.rebuildRestartDaemon.bind(this));
    this.commandRouter.sharedVars.registerCallback('alsa.device',
      this.rebuildRestartDaemon.bind(this));
    this.commandRouter.sharedVars.registerCallback('system.name',
      this.rebuildRestartDaemon.bind(this));
  } catch (e) {
    const err = 'Error starting SpotifyConnect';
    logger.error(err, e);
  }
  if (typeof metrics === 'undefined') {
    console.timeEnd('SpotifyConnect');
  } else {
    metrics.log('SpotifyConnect');
  }
};

ControllerVolspotconnect.prototype.onUninstall = function () {
  return this.onStop();
};

ControllerVolspotconnect.prototype.getUIConfig = function () {
  var defer = libQ.defer();
  var self = this;
  const langCode = this.commandRouter.sharedVars.get('language_code');
  self.commandRouter.i18nJson(path.join(__dirname, `/i18n/strings_${langCode}.json`),
    path.join(__dirname, '/i18n/strings_en.json'),
    path.join(__dirname, '/UIConfig.json'))
    .then(function (uiconf) {
      // Do we still need the initial volume setting?
      const mixname = self.commandRouter.sharedVars.get('alsa.outputdevicemixer');
      logger.debug(`config <${mixname}>: toggling initvol/volume_ctrl`);
      if ((mixname === '') || (mixname === 'None')) {
        uiconf.sections[0].content[0].hidden = false;
        uiconf.sections[0].content[6].hidden = false;
      } else {
        uiconf.sections[0].content[0].hidden = true;
        uiconf.sections[0].content[6].hidden = true;
      }

      // Asking for trouble, map index to id?
      uiconf.sections[0].content[0].config.bars[0].value = self.config.get('initvol');
      uiconf.sections[0].content[1].value = self.config.get('normalvolume');
      uiconf.sections[0].content[2].value.value = self.config.get('bitrate');
      uiconf.sections[0].content[2].value.label = self.config.get('bitrate').toString();
      uiconf.sections[0].content[3].value = self.config.get('shareddevice');
      uiconf.sections[0].content[4].value = self.config.get('username');
      uiconf.sections[0].content[5].value = self.config.get('password');
      uiconf.sections[0].content[6].value.label = self.config.get('volume_ctrl');
      uiconf.sections[0].content[6].value.value = self.config.get('volume_ctrl');
      uiconf.sections[0].content[7].value = self.config.get('gapless');
      uiconf.sections[0].content[8].value = self.config.get('autoplay');
      uiconf.sections[0].content[9].value = self.config.get('debug');

      defer.resolve(uiconf);
    })
    .fail(function () {
      defer.reject(new Error());
    });

  return defer.promise;
};

ControllerVolspotconnect.prototype.getLabelForSelect = function (options, key) {
  var n = options.length;
  for (var i = 0; i < n; i++) {
    if (options[i].value === key) { return options[i].label; }
  }

  return 'VALUE NOT FOUND BETWEEN SELECT OPTIONS!';
};

/* eslint-disable no-unused-vars */
ControllerVolspotconnect.prototype.setUIConfig = function (data) {
  var self = this;
  // Perform your installation tasks here
};

ControllerVolspotconnect.prototype.getConf = function (varName) {
  var self = this;
  // Perform your installation tasks here
};

ControllerVolspotconnect.prototype.setConf = function (varName, varValue) {
  var self = this;
  // Perform your installation tasks here
};
/* eslint-enable no-unused-vars */

ControllerVolspotconnect.prototype.getAdditionalConf = function (type, controller, data) {
  var self = this;
  return self.commandRouter.executeOnPlugin(type, controller, 'getConfigParam', data);
};

// Public Methods ---------------------------------------------------------------------------------------

ControllerVolspotconnect.prototype.createConfigFile = async function () {
  var self = this;
  logger.info('Creating VLS config file');
  try {
    let template = readFile(path.join(__dirname, 'volspotify.tmpl'));
    // Authentication
    const shared = (self.config.get('shareddevice'));
    const username = (self.config.get('username'));
    const password = (self.config.get('password'));
    // Playback
    const normalvolume = self.config.get('normalvolume');
    let initvol = '0';
    const volumestart = self.commandRouter.executeOnPlugin('audio_interface', 'alsa_controller', 'getConfigParam', 'volumestart');
    if (volumestart !== 'disabled') {
      initvol = volumestart;
    } else {
      // This will fail now - as stateMachine might not (yet) be up and running
      // TODO: Make these calls awaitable.
      // const state = self.commandRouter.volumioGetState();
      // if (state) {
      //   initvol = (`${state.volume}`);
      // }
    }
    const devicename = self.commandRouter.sharedVars.get('system.name');
    const outdev = self.commandRouter.sharedVars.get('alsa.outputdevice');
    const volcuve = self.commandRouter.executeOnPlugin('audio_interface', 'alsa_controller', 'getConfigParam', 'volumecurvemode');
    let mixname = self.commandRouter.sharedVars.get('alsa.outputdevicemixer');
    /* eslint-disable one-var */
    // Default values will be parsed as neccesary by the backend for these
    let idxcard = '',
      hwdev = '',
      mixer = '',
      mixdev = '',
      mixeropts = '',
      initvolstr = '';
    /* eslint-enable one-var */
    let mixlin = false;
    if ((mixname === '') || (mixname === 'None')) {
      logger.debug('<> or <None> Mixer found, using softvol');
      // No mixer - default to (linear) Spotify volume
      mixer = 'softvol';
      mixeropts = self.config.get('volume_ctrl');
      hwdev = `plughw:${outdev}`;
      initvolstr = self.config.get('initvol');
    } else {
      // Some mixer is defined, set inital volume to startup volume or current volume
      mixer = 'alsa';
      initvolstr = initvol;
      if (volcuve !== 'logarithmic') {
        mixlin = true;
      }
      if (outdev === 'softvolume') {
        hwdev = outdev;
        mixlin = true;
      } else {
        hwdev = `plughw:${outdev}`;
      }

      if (outdev === 'softvolume') {
        idxcard = self.getAdditionalConf('audio_interface', 'alsa_controller', 'softvolumenumber');
      } else if (outdev === 'Loopback') {
        const vconfig = fs.readFileSync('/tmp/vconfig.json', 'utf8', function (err, data) {
          if (err) {
            logger.error('Error reading Loopback config', err);
          }
        });
        const vconfigJSON = JSON.parse(vconfig);
        idxcard = vconfigJSON.outputdevice.value;
        mixname = vconfigJSON.mixer.value;
      } else {
        idxcard = outdev;
      }

      mixdev = `hw:${idxcard}`;
      mixeropts = 'linear';
    }
    if (self.config.get('debug')) {
      // TODO:
      logger.debug('Unimplemented debug mode!!');
    }
    template = await template;
    /* eslint-disable no-template-curly-in-string */
    const conf = template.replace('${shared}', shared)
      .replace('${username}', username)
      .replace('${password}', password)
      .replace('${devicename}', devicename)
      .replace('${normalvolume}', normalvolume)
      .replace('${outdev}', hwdev)
      .replace('${mixer}', mixer)
      .replace('${mixname}', mixname)
      .replace('${mixdev}', mixdev)
      .replace('${mixlin}', mixlin)
      .replace('${mixeropts}', mixeropts)
      .replace('${initvol}', initvolstr)
      .replace('${autoplay}', self.config.get('autoplay'))
      .replace('${gapless}', self.config.get('gapless'))
      .replace('${bitrate}', self.config.get('bitrate'));
      /* eslint-enable no-template-curly-in-string */

    // Sanity check
    if (conf.indexOf('undefined') > 1) {
      logger.error('SpotifyConnect Daemon config issues!');
      // get some hints as to what when wrong
      const trouble = conf.match(/^.*\b(undefined)\b.*$/gm);
      logger.error('volspotify config error: ', trouble);
      self.commandRouter.pushToastMessage('stickyerror', 'Spotify Connect', `Error reading config: ${trouble}`);
      throw Error('Undefined found found in conf');
    }
    return writeFile('/data/plugins/music_service/volspotconnect2/volspotify.toml', conf);
  } catch (e) {
    logger.error('Error creating SpotifyConnect Daemon config', e);
    self.commandRouter.pushToastMessage('error', 'Spotify Connect', `SpotifyConnect config failed: ${e}`);
  }
};

ControllerVolspotconnect.prototype.saveVolspotconnectAccount = function (data) {
  var self = this;

  // TODO: is this still requred?
  // Does UIConfig - onSave() actually resolve this promise?
  var defer = libQ.defer();

  self.config.set('initvol', data.initvol);
  self.config.set('bitrate', data.bitrate.value);
  self.config.set('normalvolume', data.normalvolume);
  self.config.set('shareddevice', data.shareddevice);
  self.config.set('username', data.username);
  self.config.set('password', data.password);
  self.config.set('volume_ctrl', data.volume_ctrl.value);
  self.config.set('gapless', data.gapless);
  self.config.set('autoplay', data.autoplay);
  self.config.set('debug', data.debug);
  self.state.bitrate = data.bitrate;
  self.rebuildRestartDaemon()
    .then(() => defer.resolve({}))
    .catch((e) => defer.reject(new Error('saveVolspotconnectAccountError')));

  return defer.promise;
};

ControllerVolspotconnect.prototype.rebuildRestartDaemon = async function () {
  var self = this;
  // Deactive state
  self.DeactivateState();
  try {
    await self.createConfigFile();
    logger.info('Restarting Vollibrespot Daemon');
    await self.VolspotconnectServiceCmds('restart');
    self.commandRouter.pushToastMessage('success', 'Spotify Connect', 'Configuration has been successfully updated');
  } catch (e) {
    self.commandRouter.pushToastMessage('error', 'Spotify Connect', `Unable to update config: ${e}`);
  }
};

ControllerVolspotconnect.prototype.awawitSpocon = function (type) {
  return new Promise((resolve, reject) => {
    this.SpotConn.once(type, resolve);
    // If it takes more than 3 seconds, something is wrong..
    setTimeout(() => { return reject; }, 3 * 1000);
  });
};

// Plugin methods for the Volumio state machine
ControllerVolspotconnect.prototype.stop = function () {
  const volStop = process.hrtime();
  logger.cmd('Received stop');
  // TODO: await confirmation of this command
  this.SpotConn.sendmsg(msgMap.get('Pause'));
  // Statemachine doesn't seem Promise aware..¯\_(ツ)_/¯
  return this.awawitSpocon(this.Events.PongPause).then(() => {
    // TODO: Is this sufficient, or should we wait for SinkInactive event..
    this.active = false;
    const end = process.hrtime(volStop);
    logger.debug(`ResolvedStop in \u001b[31m ${end[0]}s ${(end[1] / 1000000).toFixed(2)}ms \u001b[39m`);
  }).catch(error => {
    logger.error(error);
  });
};

ControllerVolspotconnect.prototype.pause = function () {
  var self = this;
  logger.cmd('Received pause');

  return self.spotifyApi.pause().catch(error => {
    self.commandRouter.pushToastMessage('error', 'Spotify Connect API Error', error.message);
    logger.error(error);
  });
};

ControllerVolspotconnect.prototype.play = function () {
  var self = this;
  logger.cmd(`Received play: <${this.active}>`);
  if (this.active) {
    return self.spotifyApi.play().catch(error => {
      self.commandRouter.pushToastMessage('error', 'Spotify Connect API Error', error.message);
      logger.error(error);
      self.checkActive();
    });
  } else {
    logger.debug('Playing on:', this.device);
    return self.spotifyApi.transferMyPlayback({ deviceIds: [this.deviceID], play: true }).catch(error => {
      self.commandRouter.pushToastMessage('error', 'Spotify Connect API Error', error.message);
      logger.error(error);
    });
  }
};

ControllerVolspotconnect.prototype.next = function () {
  var self = this;
  logger.cmd('Received next');
  return self.spotifyApi.skipToNext().catch(error => {
    self.commandRouter.pushToastMessage('error', 'Spotify Connect API Error', error.message);
    logger.error(error);
  });
};

ControllerVolspotconnect.prototype.previous = function () {
  var self = this;
  logger.cmd('Received previous');
  return self.spotifyApi.skipToPrevious().catch(error => {
    self.commandRouter.pushToastMessage('error', 'Spotify Connect API Error', error.message);
    logger.error(error);
  });
};

ControllerVolspotconnect.prototype.seek = function (position) {
  var self = this;
  logger.cmd(`Received seek to: ${position}`);
  return self.spotifyApi.seek(position).catch(error => {
    self.commandRouter.pushToastMessage('error', 'Spotify Connect API Error', error.message);
    logger.error(error);
  });
};

ControllerVolspotconnect.prototype.seekTimerAction = function () {
  var self = this;

  if (self.state.status === 'play') {
    if (seekTimer === undefined) {
      seekTimer = setInterval(() => {
        self.state.seek = self.state.seek + 1000;
      }, 1000);
    }
  } else {
    clearInterval(seekTimer);
    seekTimer = undefined;
  }
};
