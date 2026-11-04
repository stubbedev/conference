"""Mint a dev token: SPEECH_SECRET=... python -m tools.mint_token [room] [member]."""

import os
import sys

from app.auth import mint

room, member = (sys.argv[1:] + ["dev", "dev"])[:2]
print(mint(os.environ["SPEECH_SECRET"].encode(), room, member))
