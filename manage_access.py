"""Command-line access management, for the cases the admin UI cannot cover:
appointing the first administrator, and getting back in when nobody can.

    python manage_access.py list
    python manage_access.py grant eric.musonera --admin --dashboard
    python manage_access.py revoke someone --dashboard
    python manage_access.py set-password eric.musonera

Run it on the machine that holds DATABASE_URL; there is no network path to any
of this, which is the point.
"""
import argparse
import getpass
import sys

from database import SessionLocal
import models
from server import hash_password, verify_password

SURFACES = {
    "field": "can_field",
    "dashboard": "can_dashboard",
    "admin": "is_admin",
}


def _find(db, username):
    user = db.query(models.User).filter(models.User.username == username).first()
    if user is None:
        sys.exit(f"No user named {username!r}. Run 'list' to see the accounts.")
    return user


def _show(user):
    flags = " ".join(
        name for name, column in SURFACES.items() if getattr(user, column, False)
    )
    return f"{user.username:20} {user.full_name:24} [{flags or 'no access'}]"


def cmd_list(db, _args):
    users = db.query(models.User).order_by(models.User.username).all()
    if not users:
        print("No users.")
        return
    for user in users:
        print(_show(user))


def _set_flags(db, args, value):
    user = _find(db, args.username)
    chosen = [s for s in SURFACES if getattr(args, s)]
    if not chosen:
        sys.exit("Pick at least one of --field, --dashboard, --admin.")

    if not value and "admin" in chosen and user.is_admin:
        remaining = (
            db.query(models.User)
            .filter(models.User.is_admin.is_(True), models.User.id != user.id)
            .count()
        )
        if remaining == 0:
            sys.exit("That is the only administrator; grant admin elsewhere first.")

    for surface in chosen:
        setattr(user, SURFACES[surface], value)
    db.commit()
    print(_show(user))


def cmd_grant(db, args):
    _set_flags(db, args, True)


def cmd_revoke(db, args):
    _set_flags(db, args, False)


def _read_password(prompt):
    """Read a password, minus the line ending some terminals hand back.

    MinTTY (Git Bash) can return the trailing carriage return as part of the
    input. Hashing that stores a password nobody can ever type again, so drop
    CR and LF - neither can be part of a password typed at a prompt. Spaces are
    left alone: those are the user's to choose.
    """
    return getpass.getpass(prompt).strip("\r\n")


def cmd_set_password(db, args):
    user = _find(db, args.username)
    # getpass blocks forever on a piped stdin, so say so rather than hang.
    if not sys.stdin.isatty():
        sys.exit("set-password needs an interactive terminal; run it directly, not piped.")
    password = _read_password(f"New password for {user.username}: ")
    if not password:
        sys.exit("Empty password, nothing changed.")
    if password != _read_password("Repeat: "):
        sys.exit("Passwords did not match, nothing changed.")

    user.password_hash = hash_password(password)
    db.commit()

    # Read the row back and check the stored hash against what was typed. A
    # password that cannot be verified here will not work at the login screen
    # either, and finding that out now beats finding out from a locked-out user.
    db.refresh(user)
    if not verify_password(password, user.password_hash):
        sys.exit(
            f"Password was written for {user.username} but does not verify against "
            "the stored hash. Do not rely on it; report this rather than retrying."
        )
    print(f"Password updated for {user.username}, and verified against the stored hash.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="show every account and its access")

    for name, help_text in (("grant", "give access"), ("revoke", "take access away")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("username")
        p.add_argument("--field", action="store_true", help="Field App")
        p.add_argument("--dashboard", action="store_true", help="Dashboard")
        p.add_argument("--admin", action="store_true", help="approve permission requests")

    p = sub.add_parser("set-password", help="set a password without the web app")
    p.add_argument("username")

    args = parser.parse_args()
    handlers = {
        "list": cmd_list,
        "grant": cmd_grant,
        "revoke": cmd_revoke,
        "set-password": cmd_set_password,
    }
    db = SessionLocal()
    try:
        handlers[args.command](db, args)
    finally:
        db.close()


if __name__ == "__main__":
    main()
