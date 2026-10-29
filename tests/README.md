# Hosted runtime prerequisites

Hosted Kata qualification retains the already verified upstream kit as well as its installed
members. After the existing exact size/SHA-256 checks and extraction, keep the same archive at
`/opt/kata/kata-static-4.1.0-amd64.tar.zst`, owned by root with mode `0600`, before owner tests.
Deployment's public `PrivateKataFixture` declares this path so its native backend can retain
archive custody throughout runtime lifetime. Extraction alone does not supply that input.
This prepares the immutable fixture artifact; it changes no scheduling, timeout, trusted-source
check, host qualification, assertion or test discovery. It applies only to isolated hosted
Ubuntu runners, not workstation registration or legacy installations. #562's physical failure
is the outside-in observation; the updated owner closure must be freshly qualified afterward.
