var colors = require('colors');
var readLine = require('readline');
const sqlite3 = require('sqlite3').verbose();
var SteamCommunity = require('steamcommunity');
var community = new SteamCommunity();
const { autoRelogin } = require('./auto-relogin');
const SteamTotp = require('steam-totp');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getSteam2FASecret(accountName) {
    try {
        const file = path.join(
            os.homedir(),
            '.config',
            'r4r',
            'steam-2fa.json'
        );

        const data = JSON.parse(
            fs.readFileSync(file, 'utf8')
        );

        return data?.[accountName]?.shared_secret || null;
    } catch {
        return null;
    }
}
const SteamID = require('steamid');
var config = require('./config.json');
const FormData = require('form-data');
const fetch = require('node-fetch');
var moment = require('moment');
moment().format();

const { version } = require('./package.json');

function updateChecker() {
    fetch('https://raw.githubusercontent.com/KniferFTW/rep4rep-bot/main/package.json', {
        method: 'GET'
    })

    .then(res => res.json())
    .then(json => {
        if(json.version > version) {
            console.log(`\n[UPDATE] New update available. Current version: v${version}, newest version: v${json.version}.`.bold.yellow)
            console.log('[UPDATE] Get the latest version here: https://github.com/KniferFTW/rep4rep-bot'.bold.yellow)
        }
    }).catch(error => {
            console.log('\n[UPDATE] Unable to check for new updates!'.bold.red)
    });
}

var rl = readLine.createInterface({
	"input": process.stdin,
	"output": process.stdout
});

const autoMode = process.argv.includes('--auto');

function autoError(message) {
    if (autoMode) {
        console.error('[AUTO ERROR]', message);
        process.exit(1);
    }

    homeMenu(message);
}

let db = new sqlite3.Database('./steamprofiles.db', (err) => {
    if (err) {
        console.log(err);
        process.exit(1);
    }

    createTables();

    if (autoMode) {
        console.log('[AUTO] Starting Auto Run mode...');
        autoRun();
    } else {
        homeMenu();
    }
});

function createTables() {
    let tables = [
        `CREATE TABLE IF NOT EXISTS steamprofiles (
            id integer PRIMARY KEY AUTOINCREMENT,
            username varchar,
            steamId varchar UNIQUE,
            cookies text,
            token varchar,
            last_comment datetime
        )`,
    ];

    tables.forEach(query => {
        db.run(query, function(err) {
            if (err) {
                console.log(err);
                process.exit();
            }
        });
    });
}

function printHeader(headTitle = 'Home') {
    console.log('\x1Bc');
    let title = 'Rep4Rep Bot - ' + headTitle + '\n';
    console.log(title.bold.bgBlue);
}

function homeMenu(err = false) {
    printHeader();
    setTimeout(updateChecker, 1500);
    console.log('1) Auto Run');
    console.log('2) Manage Steam Accounts');
    console.log('CTRL + C to exit at any time.'.gray);
    if (err) { console.log(err.bold.red); }

    let validOptions = [1, 2];
    rl.question('>> ', function(chosenOption) {
        if (validOptions.includes(parseInt(chosenOption))) {
            switch (parseInt(chosenOption)) {
                case 1:
                    autoRun();
                    break;
                case 2:
                    profilesMenu();
                    break;
                default:
                    break;
            }
        } else {
            homeMenu('Invalid Option, Retry.');
        }
    });
}

async function profilesMenu(err = false) {
    printHeader('Manage Steam Accounts');

    let steamProfiles = await db_all('SELECT id, username, steamId, last_comment FROM steamprofiles');
    if (Object.keys(steamProfiles).length !== 0) {
        console.table(steamProfiles);
    } else {
        console.log('[ No Accounts added yet ]'.bold);
    }

    console.log();
    console.log('1) Add a Steam Account');
    console.log('2) Re-Login to a Steam Account');
    console.log('3) Remove a Steam Account');
    console.log('4) Back \n'.gray);
    if (err) { console.log(err.bold.red); }

    let validOptions = [1, 2, 3, 4];
    rl.question('>> ', function(chosenOption) {
        if (validOptions.includes(parseInt(chosenOption))) {
            switch (parseInt(chosenOption)) {
                case 1:
                    addSteamAccount();
                    break;
                case 2:
                    reloginSteamAccount();
                    break;
                case 3:
                    removeSteamAccount();
                    break;
                case 4:
                    homeMenu();
                    break;
                default:
                    break;
            }
        } else {
            profilesMenu('Invalid Option, Retry.');
        }
    });
}

async function db_all(query) {
    return new Promise(function(resolve,reject){
        db.all(query, function(err,rows){
           if(err){return reject(err);}
           resolve(rows);
         });
    });
}

async function isLoggedIn(client = community) {
    return new Promise(function(resolve,reject){
         client.loggedIn(function(err, loggedIn, familyView) {
             if(err){return reject(err);}
             resolve(loggedIn);
         });
    });
}

async function autoRun() {
    const response = await fetch('https://rep4rep.com/pub-api/user/steamprofiles?apiToken=' + config.apiToken);
    const data = await response.json();
    if (data.error) {
        autoError(data.error);
        return;
    }

    // hella nasty
    let repSteamProfiles = [];
    let repSteamProfilesObj = {};
    data.forEach((steamProfile) => {
        repSteamProfiles.push(steamProfile.steamId);
        repSteamProfilesObj[steamProfile.steamId] = steamProfile.id;
    });

    let steamProfiles = await db_all('SELECT id, username, steamId, last_comment, cookies, token FROM steamprofiles');
    if (Object.keys(steamProfiles).length == 0) {
        autoError('No local steam accounts added to comment from.');
        return;
    }

    for (const steamProfile of steamProfiles) {
        // if profile doesnt exist on rep4rep add it
        if (!repSteamProfiles.includes(steamProfile.steamId)) {
            console.log('account not added on rep4rep!!');
            let form = new FormData();
            form.append('apiToken', config.apiToken);
            form.append('steamProfile', steamProfile.steamId);
            const response = await fetch('https://rep4rep.com/pub-api/user/steamprofiles/add', {
                method: 'post',
                body: form
            });
            const data = await response.json();
            if (data.error) {
                autoError(data.error);
                return;
            }

            console.log(steamProfile.username + ' added to rep4rep.');
            console.log('[AUTO] Profile added. Its Rep4Rep ID will be loaded on the next run.');
            continue;
        }

        let hours = moment().diff(moment(steamProfile.last_comment), 'hours');
        if (hours >= 24 || !steamProfile.last_comment) {
            console.log('attempting to leave comments from: ' + steamProfile.username);
            console.log('[ 15 sec delay between each comment ]'.bold.cyan);

            let accountCommunity = new SteamCommunity();
            try {
                if (steamProfile.cookies) {
                    accountCommunity.setCookies(JSON.parse(steamProfile.cookies));
                }
                accountCommunity.oAuthToken = steamProfile.token || null;
                const loggedIn = steamProfile.cookies ? await isLoggedIn(accountCommunity) : false;
                if (!loggedIn) {
                    console.log('[RELOGIN] Session expired: ' + steamProfile.username);
                    const restoredClient = await autoRelogin(steamProfile.username, db);
                    if (!restoredClient) {
                        console.log('[RELOGIN] Skipping account.');
                        continue;
                    }
                    // Reuse the verified client, including its new cookies and session.
                    accountCommunity = restoredClient;
                }
            } catch (err) {
                console.log('[AUTO] Session check failed for ' + steamProfile.username + ': ' + err.message);
                continue;
            }

            // fetch available tasks  (30)
            const response = await fetch('https://rep4rep.com/pub-api/tasks?apiToken=' + config.apiToken + '&steamProfile=' + repSteamProfilesObj[steamProfile.steamId]);
            const data = await response.json();
            if (data.error) {
                autoError(data.error);
                return;
            }

            let failedAttempts = 0;
            for (const task of data) {
                if (failedAttempts >= 2) {
                    console.log('failed twice, skipping steamProfile.'.bold.yellow);
                    break;
                }

                console.log(steamProfile.username + ' -> ' + task.targetSteamProfileName + ' | ' + task.requiredCommentText);
                try {
                    await new Promise((resolve, reject) => {
                        accountCommunity.postUserComment(task.targetSteamProfileId, task.requiredCommentText, (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    console.log('posted comment successfully.'.bold.green);

                    await new Promise((resolve, reject) => {
                        db.run(`UPDATE steamprofiles SET last_comment=DATETIME('now', 'localtime') WHERE id=?`,
                            [steamProfile.id], err => err ? reject(err) : resolve());
                    });

                    const form = new FormData();
                    form.append('apiToken', config.apiToken);
                    form.append('taskId', task.taskId);
                    form.append('commentId', task.requiredCommentId);
                    form.append('authorSteamProfileId', repSteamProfilesObj[steamProfile.steamId]);
                    const completeResponse = await fetch('https://rep4rep.com/pub-api/tasks/complete', {
                        method: 'post', body: form
                    });
                    const completeData = await completeResponse.json();
                    if (completeData.error) {
                        console.log('[AUTO] Task completion error: ' + completeData.error);
                        failedAttempts++;
                    } else {
                        console.log(completeData.info ?? completeData.success);
                    }
                } catch (err) {
                    console.log('[AUTO] Comment/task failed: ' + err.message);
                    failedAttempts++;
                }
                await sleep(15000);
            }
        } else {
            console.log(steamProfile.username.bold.cyan + ' not ready yet. Try again in: ' + (24-hours).toString().bold.red + ' hours.');
            continue;
        }
    }
    console.log('Done with Auto Run, Exiting.'.bold.green);
    process.exit();
}

async function sleep(millis) {
    return new Promise(resolve => setTimeout(resolve, millis));
}

async function addSteamAccount(err = false) {
    printHeader('Add a Steam Account');
    if (err) { console.log(err.bold.red); }
    rl.question("Steam Login Username: ", function(accountName) {
    	rl.question("Password: ", function(password) {
    		doLogin(accountName, password);
    	});
    });
}

async function reloginSteamAccount() {
    rl.question("Steam Login Username: ", function(accountName) {

        console.log(accountName);
        db.get('SELECT id, cookies, token FROM steamprofiles WHERE username = ?', [accountName], function(err, row) {
          if (err) {
            console.log(err.message);
            process.exit();
          }

          if (!row) {
            profilesMenu('No saved account with that username. Use "Add a Steam Account" instead.');
            return;
          }

          rl.question("Password: ", function(password) {
      		doLogin(accountName, password);
          });
        });
    });
}

async function removeSteamAccount() {
    rl.question("Username or id to remove: ", function(accountName) {
        db.run(`DELETE FROM steamprofiles WHERE id = ? OR username = ?`, [accountName, accountName], function(err) {
          if (err) {
            console.log(err.message);
            process.exit();
          }
          profilesMenu('Steam Account Removed! (if it was found)');
        });
    });
}

function doLogin(accountName, password, authCode, twoFactorCode, captcha) {
	community.login({
		"accountName": accountName,
		"password": password,
		"authCode": authCode,
		"twoFactorCode": twoFactorCode,
		"captcha": captcha
	}, function(err, sessionID, cookies, steamguard, oauthToken) {
		if(err) {
			if(err.message == 'SteamGuardMobile') {
			        const sharedSecret = getSteam2FASecret(accountName);

			        if (sharedSecret) {
			                const code = SteamTotp.generateAuthCode(sharedSecret);
			                console.log('[2FA] Generated Steam Guard code automatically.');
			                doLogin(accountName, password, null, code);
			        } else {
			                rl.question("Steam Authenticator Code: ", function(code) {
			                        doLogin(accountName, password, null, code);
			                });
			        }

			        return;
			}

			if(err.message == 'SteamGuard') {
				console.log("An email has been sent to your address at " + err.emaildomain);
				rl.question("Steam Guard Code: ", function(code) {
					doLogin(accountName, password, code);
				});

				return;
			}

			if(err.message == 'CAPTCHA') {
				console.log(err.captchaurl);
				rl.question("CAPTCHA: ", function(captchaInput) {
					doLogin(accountName, password, authCode, twoFactorCode, captchaInput);
				});

				return;
			}

            profilesMenu(err.message);
			return;
		}

		console.log("Logged on!");

        const steamId64 = community.steamID.getSteamID64();
        db.get('SELECT id FROM steamprofiles WHERE username = ? OR steamId = ?',
            [accountName, steamId64], function(lookupErr, existing) {
                if (lookupErr) return profilesMenu(lookupErr.message);
                const sql = existing
                    ? 'UPDATE steamprofiles SET username=?, steamId=?, cookies=?, token=? WHERE id=?'
                    : 'INSERT INTO steamprofiles (username, steamId, cookies, token) VALUES (?, ?, ?, ?)';
                const params = existing
                    ? [accountName, steamId64, JSON.stringify(cookies), oauthToken, existing.id]
                    : [accountName, steamId64, JSON.stringify(cookies), oauthToken];
                db.run(sql, params, function(err) {
                    if (err) return profilesMenu(err.message);
                    profilesMenu('Steam Account added! (or updated)');
                });
            });
	});
}