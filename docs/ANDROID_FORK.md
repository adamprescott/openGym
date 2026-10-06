# Android builds for this fork

The optional **Build signed Android APK** GitHub Actions workflow creates a separately
signed app. It does not embed a server address: choose **Connect to my server** in the
installed app and pair from a signed-in browser. Server deployment and APK installation
are independent; deploying a web image does not replace the frontend bundled in an APK.

## One-time setup

1. Enable Actions in the fork. Create a GitHub environment named `android-release`;
   restrict it to trusted branches/tags and optionally require approval.
2. Create a release keystore locally using Android Studio's **Generate Signed Bundle / APK**
   wizard, or `keytool`. Back up the keystore, alias, and passwords separately. Never commit
   the keystore. Every update to your fork app must use the same signing key and app ID.
3. Add these environment secrets (repository secrets also work):

   | Secret | Value |
   | --- | --- |
   | `ANDROID_KEYSTORE_B64` | Base64-encoded contents of your keystore |
   | `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
   | `ANDROID_KEY_ALIAS` | Signing key alias |
   | `ANDROID_KEY_PASSWORD` | Key password, if different from the keystore password |

4. Add variable `ANDROID_APPLICATION_ID`, for example `io.github.yourusername.opengym`.
   This ID is public inside the APK; do not use a private deployment hostname. It must differ
   from upstream so the two apps can coexist. The Java namespace intentionally remains
   unchanged; Gradle overrides only the installed application identity.

## Build and install

Run **Build signed Android APK → Run workflow** on `main`. Supply a numeric `version_code`
greater than your previous fork build (start at `1` for a new app ID). Download the
`signed-android-*` artifact, extract it, and install its APK on your phone. Android may ask
you to allow installations from your browser or file manager. Updates require installation
approval; this workflow cannot silently update your phone.

For automatic release assets, set repository variable `ANDROID_RELEASE_ENABLED=true`,
set `ANDROID_VERSION_CODE` to the next version code before each release, and publish a
GitHub release whose commit is included in `main`. Its signed APK and checksum are attached
to that release. Keep `frontend/package.json` and Android `versionName` aligned with your
release version. Re-running an upload will not overwrite existing release assets.

The workflow disables the upstream GitLab update check with `VITE_DISABLE_UPDATES=1`.
Install future APKs from this fork's artifacts/releases manually; an upstream APK cannot
update an app signed with your key. Local builds need the same flag and the
`ANDROID_APPLICATION_ID` / `ANDROID_VERSION_CODE` environment overrides if they are meant
to update a CI-built fork installation. Without those overrides, upstream build behavior
is preserved. Protect and retain your key: losing it prevents normal updates to the app.

The workflow uses Node 22, Java 21, Android SDK 35, and the repository's Gradle wrapper.
It runs frontend tests before the mobile build. Native runtime behavior still needs a real
device check: pairing, sync, notifications, and installing the next signed version.
