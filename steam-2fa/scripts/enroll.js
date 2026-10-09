#!/usr/bin/env node
'use strict';

const {enroll} = require('../src/enrollment');

if (require.main === module) {
    require('../src/cli').main('enroll');
}

module.exports = {enroll};
