#!/bin/bash

mongod --smallfiles 1>/dev/null 2>&1 &
redis-server 1>/dev/null 2>&1 &
sleep 3
node /opt/pangalink.net/index.js