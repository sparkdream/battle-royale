#!/bin/sh
# Hosts such as Akash mount the data volume owned by root. Started as root,
# hand the volume to the node user and drop root before starting the server.
set -e
if [ "$(id -u)" = 0 ]; then
  chown node:node /app/data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
