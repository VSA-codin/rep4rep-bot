#!/usr/bin/env node
'use strict';

const {finalize} = require('../src/enrollment');

if (require.main === module) {
    require('../src/cli').main('finalize');
}

module.exports = {finalize};
