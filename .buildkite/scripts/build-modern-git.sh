#!/usr/bin/env bash
set -euo pipefail

version="2.50.1"
archive="git-${version}.tar.xz"
expected_sha256="7e3e6c36decbd8f1eedd14d42db6674be03671c2204864befa2a41756c5c8fc4"
workspace="$(mktemp -d)"
install_root="/tmp/intelip-tabellio-git-${version}"
artifact_dir=".artifacts/toolchain"
apt_lists="${workspace}/apt-lists"
apt_source_list="${workspace}/sources.list"
apt_source_parts="${workspace}/apt-sources.list.d"
apt_options=(
  -o Dir::Etc::sourcelist="$apt_source_list"
  -o Dir::Etc::sourceparts="$apt_source_parts"
  -o Dir::State::lists="$apt_lists"
  -o APT::Get::List-Cleanup="1"
)
packages=(
  build-essential
  ca-certificates
  gettext
  libcurl4-gnutls-dev
  libexpat1-dev
  libssl-dev
  zlib1g-dev
)

trap 'rm -rf "$workspace" "$install_root"' EXIT
rm -rf "$install_root"
mkdir -p "$install_root"

missing_packages=()
for package in "${packages[@]}"; do
  if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx "install ok installed"; then
    missing_packages+=("$package")
  fi
done

if ((${#missing_packages[@]} > 0)); then
  mkdir -p "${apt_lists}/partial" "$apt_source_parts"
  chmod 755 "$workspace" "$apt_lists" "${apt_lists}/partial" "$apt_source_parts"
  if [[ -f /etc/apt/sources.list ]]; then
    awk '
      /^[[:space:]]*deb(-src)?[[:space:]]/ &&
      /(ubuntu\.com\/(ubuntu|ubuntu-ports)|debian\.org\/debian(-security|-ports)?)/ { print }
    ' /etc/apt/sources.list > "$apt_source_list"
  else
    : > "$apt_source_list"
  fi
  for source_file in \
    /etc/apt/sources.list.d/ubuntu.sources \
    /etc/apt/sources.list.d/debian.sources \
    /etc/apt/sources.list.d/ubuntu.list \
    /etc/apt/sources.list.d/debian.list; do
    [[ -f "$source_file" ]] || continue
    cp -- "$source_file" "$apt_source_parts/"
  done
  sudo apt-get "${apt_options[@]}" update
  sudo apt-get "${apt_options[@]}" install -y --no-install-recommends "${missing_packages[@]}"
fi

curl --fail --location --silent --show-error \
  "https://www.kernel.org/pub/software/scm/git/${archive}" \
  --output "${workspace}/${archive}"

printf '%s  %s\n' "$expected_sha256" "${workspace}/${archive}" | sha256sum --check
tar -C "$workspace" -xf "${workspace}/${archive}"

make -C "${workspace}/git-${version}" -j2 prefix="$install_root" all
make -C "${workspace}/git-${version}" prefix="$install_root" install

mkdir -p "$artifact_dir"
tar -C "$install_root" -czf "${artifact_dir}/git-${version}-linux-amd64.tar.gz" .
