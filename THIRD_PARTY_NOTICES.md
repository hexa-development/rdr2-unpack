# Third-party notices

`rdr2-unpack` bundles no game data, no decryption keys, and no third-party
binaries. It drives software that is already installed on the machine running
it, and every byte it produces comes from the user's own copy of the game.

## Software this tool invokes

- **FiveFury** — used by the Python conversion scripts to read RSC7 drawables,
  texture dictionaries and bounds. Distributed under the Unlicense; installed
  from PyPI by `pip install -r requirements.txt`, not bundled here.
- **CitizenFX / FiveM `formats:convert`** — invoked from the user's installed
  FiveM (or RedM) runtime to convert RSC8 resources to RSC7. FiveM binaries and
  shader assets are not bundled.
- **ArchiveExplorer** — a locally built helper used to read the user's own RPF8
  archives. No upstream license was found for that helper, so neither its
  binaries nor its source are redistributed here.
- **RDR2 encryption keys** (`secrets.bin`), Oodle libraries, archives, models,
  textures and every generated cache stay on the user's machine.

## Trademarks

Red Dead Redemption 2, its imagery, names and marks remain the property of
Rockstar Games and Take-Two Interactive. This is an unofficial community
development tool with no affiliation to, or endorsement by, either company.

## Your responsibility

Users are responsible for complying with the licenses and terms that apply to
their game installation and to their local conversion tools. Assets produced by
this tool are derived from a copyrighted game and must not be redistributed.
