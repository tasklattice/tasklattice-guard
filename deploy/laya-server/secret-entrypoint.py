"""Load the console password without putting it in Compose environment metadata."""
import os
from pathlib import Path
import sys

from argon2 import PasswordHasher

password = Path(os.environ.pop("LAYA_ADMIN_PASSWORD_FILE")).read_text().strip()
if len(password) < 20:
    raise SystemExit("Use a generated administrator password of at least 20 characters.")
os.environ["LAYA_ADMIN_PASSWORD_HASH"] = PasswordHasher().hash(password)
os.execvp(sys.argv[1], sys.argv[1:])
