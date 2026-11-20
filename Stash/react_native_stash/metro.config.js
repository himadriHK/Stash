const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// react-native-mega is linked with `file:../react-native-mega`, so Metro must
// watch the sibling package and resolve its own dependencies.
config.watchFolders = [path.resolve(__dirname, '../react-native-mega')];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(__dirname, '../react-native-mega/node_modules'),
];

// Add wasm asset support (expo-sqlite web imports wa-sqlite.wasm).
config.resolver.assetExts.push('wasm');

// Add COEP and COOP headers to support SharedArrayBuffer.
config.server.enhanceMiddleware = (middleware) => {
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    middleware(req, res, next);
  };
};

module.exports = config;
