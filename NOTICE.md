# Notice

## License

This repository is **MIT-licensed as a whole**: see [LICENSE](LICENSE). Source files carry
`SPDX-License-Identifier: MIT`. `steam-2fa/` keeps its own [MIT license](steam-2fa/LICENSE), which
is the same license.

Contributions are accepted on the understanding that they are MIT-licensed.

## Provenance

This project started from earlier rep4rep bot code. Since 2.1.0 the program is an independent
reimplementation, organised in separate modules (`src/`, `lib/`) with its own structure, naming
and messages. It shares its purpose and the public Rep4Rep API with the earlier bots.

How this was checked: the new code was compared line by line with the last version that still
contained the earlier `index.js`. Of 599 non-trivial lines in the new code, 13 are identical, and
all of them are standard library imports, the database column names (kept so existing databases
keep working) or a one-line call into a library. Nothing else is shared.

This is a reimplementation by people who had seen the earlier code, not a documented clean-room
process, and it is not legal advice. If an upstream author believes something should be credited
or changed, contact VSA and it will be addressed.

**Upstream project:** https://github.com/rep4rep/rep4rep-bot  
**Community fork:** https://github.com/KniferFTW/rep4rep-bot  
**Service/API:** https://rep4rep.com/  
**VSA maintainer:** VSA  
**Discord:** `vacsecuredapproved`

Credits stay with the original authors for the idea, the earlier bots and the Rep4Rep service. VSA
does not claim authorship of the original project. This edition is maintained independently and is
not presented as an official rep4rep project.

## No data collection

The bot has no telemetry, no analytics, no crash reporting and no update pings. It contacts Rep4Rep
and Steam only, and everything it stores stays in files on your machine, readable only by your user
account (`umask 077`, mode `600`). See the README Privacy section for every stored file and every
network destination.
