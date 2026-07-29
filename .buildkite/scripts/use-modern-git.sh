#!/usr/bin/env bash
set -euo pipefail

required_version="2.50.1"
actual_version="$(git version | awk '{print $3}')"

if ! awk -v actual="$actual_version" -v required="$required_version" '
  BEGIN {
    split(actual, actual_parts, ".")
    split(required, required_parts, ".")
    for (part_index = 1; part_index <= 3; part_index++) {
      actual_part = actual_parts[part_index] + 0
      required_part = required_parts[part_index] + 0
      if (actual_part > required_part) {
        exit 0
      }
      if (actual_part < required_part) {
        exit 1
      }
    }
    exit 0
  }
'; then
  printf 'Git %s or newer is required; found %s.\n' "$required_version" "$actual_version" >&2
  exit 1
fi

git --version
