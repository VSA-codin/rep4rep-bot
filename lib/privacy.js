// SPDX-License-Identifier: MIT
'use strict';

// Steam login names are credentials-adjacent: anyone who knows one only needs
// the password. Logs (journald, cron files, pasted bug reports) therefore show
// a masked form: "vacsecuredapproved" -> "va***d".
function maskLogin(login) {
    const s = String(login || '');
    if (s.length <= 3) return '***';
    return s.slice(0, 2) + '***' + s.slice(-1);
}

module.exports = { maskLogin };
