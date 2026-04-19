#!/usr/bin/env bash
# claude-mock-timeout.sh — mock claude that sleeps indefinitely (timeout test).
# The test sets a very short timeout_ms so this triggers SIGTERM quickly.

sleep 300
