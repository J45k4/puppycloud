use bun routes when making apis in server.
use spaces with an indent size of 4 in all shared editors and generated files.
whe using sqlite use bun native sqlite client

Before doing anything make sure bun install is run.

After changes run:
- bun run format-fix
- bun run check
- bun run lint-fix
- bun run test


Dont update readme unless specifically instructed

Dont add external dependecies if not specifically requested.

When making changes always consider wether tests should be updated to cover new case or new tests should be implemented.
