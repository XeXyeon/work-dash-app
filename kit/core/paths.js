const os = require('os');
const path = require('path');

const HOME = os.homedir();
const REAL_HOME = (() => { try { return os.userInfo().homedir; } catch { return null; } })();
const WD = process.env.WORK_DASH_DIR || path.join(HOME, '.work-dash');

module.exports = { HOME, REAL_HOME, WD };
