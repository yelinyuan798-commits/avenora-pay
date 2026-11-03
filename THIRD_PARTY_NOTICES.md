# Third-party notices

Avenora Pay is an independently implemented project. The original project code is available under the MIT License in [LICENSE](LICENSE). Development used AI-assisted tooling. DujiaoPay is referenced only for API compatibility; this project is not affiliated with or endorsed by DujiaoPay and does not include its proprietary server source.

Dependencies retain their own licenses. The lockfile records exact resolved versions and declared licenses; full license texts are included with the installed packages. Preserve the applicable notices when redistributing dependencies or a bundled application.

| Direct dependency | License | Source |
| --- | --- | --- |
| Express | MIT | https://github.com/expressjs/express |
| React / React DOM | MIT | https://github.com/facebook/react |
| Lucide React | ISC | https://github.com/lucide-icons/lucide |
| qrcode | MIT | https://github.com/soldair/node-qrcode |
| Vite (build tool) | MIT | https://github.com/vitejs/vite |

Public blockchain identifiers, protocol references, and test vectors are documented in [docs/chains.md](docs/chains.md) and the tests. They are not credentials or endorsements from those projects.

## Bitcoin address test vectors

The Bitcoin address test vectors used in `tests/chains.test.mjs` are from [BIP-173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki) (Pieter Wuille and Greg Maxwell) and [BIP-350](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki) (Pieter Wuille), licensed under BSD-2-Clause. Their attribution and license are retained here; they are not relicensed as original Avenora Pay code.

Copyright: the respective BIP authors named above.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
