import os
import sys

from google_auth_oauthlib.flow import InstalledAppFlow


SCOPES = ["https://www.googleapis.com/auth/drive"]


def main() -> int:
    client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", "").strip()

    if not client_id or not client_secret:
        print("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.", file=sys.stderr)
        return 1

    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }

    flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
    creds = flow.run_local_server(
        host="localhost",
        port=0,
        access_type="offline",
        prompt="consent",
    )

    print("\nGOOGLE_OAUTH_REFRESH_TOKEN")
    print(creds.refresh_token or "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
