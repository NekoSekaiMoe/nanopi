# Container image for nanopi, published to ghcr.io/<owner>/nanopi on release tags.
#
# The bundle is built by .github/workflows/build-binaries.yml and placed at
# /nanopi.js by the workflow before this file runs, so the image never rebuilds
# what the release already smoked-tested.
#
#   docker run --rm -it -v "$PWD:/workspace" ghcr.io/nekosekaimoe/nanopi --help
FROM node:24-bookworm-slim

# The bash tool drives these; a container without them leaves the agent unable
# to read a repository's history or search it the way it does on a host.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system nanopi \
  && useradd --system --gid nanopi --create-home --home-dir /home/nanopi nanopi \
  && mkdir -p /opt/nanopi \
  && chown nanopi:nanopi /opt/nanopi

COPY --chown=nanopi:nanopi nanopi.js /opt/nanopi/nanopi.js

USER nanopi
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/nanopi/nanopi.js"]
