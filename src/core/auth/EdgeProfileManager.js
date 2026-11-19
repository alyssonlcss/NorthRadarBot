const path = require('path');
const fs = require('fs');
const os = require('os');

class EdgeProfileManager {
  static getEdgeUserDataDir() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
  }

  static isEdgeInstalled() {
    const edgePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    return edgePaths.some((p) => fs.existsSync(p));
  }

  static getEdgeExecutable() {
    const edgePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of edgePaths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
}

module.exports = EdgeProfileManager;

