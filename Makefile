# co-copilot — build, flash, and release orchestration.
#
# The firmware is a PlatformIO project (firmware/, env `m5dial`); the bridge is
# a Node.js app (bridge/). Cut a release by pushing a `firmware-v*` tag — the
# release-firmware-* targets below do that, and
# .github/workflows/firmware-release.yml builds the .bin and publishes a
# GitHub Release.

FIRMWARE_BIN := firmware/.pio/build/m5dial/firmware.bin

.PHONY: help
help: ## Show all available targets
	@grep -E '^[a-zA-Z0-9_.-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-28s\033[0m %s\n", $$1, $$2}'

# ---- firmware -------------------------------------------------------------
.PHONY: build upload monitor clean firmware-test
build: ## Build the M5Dial firmware
	cd firmware && pio run

firmware-test: ## Run firmware host tests (session-pal parser/UI logic, no hardware)
	./firmware/test/run-host-tests.sh

upload: ## Build + USB-flash the firmware to a connected device
	cd firmware && pio run -t upload

monitor: ## Open the serial monitor
	cd firmware && pio run -t monitor

clean: ## Remove firmware build artifacts
	cd firmware && pio run -t clean

# ---- bridge ---------------------------------------------------------------
.PHONY: bridge-install bridge-test flash flash-release
bridge-install: ## Install bridge dependencies
	cd bridge && npm install

bridge-test: ## Run the bridge test suite
	cd bridge && npm test

# ---- install (managed background service + MCP registration) --------------
# The "clone -> install -> use" path: deps, register co-copilot as an HTTP MCP
# server in ~/.copilot/mcp-config.json, and install a per-user background service
# (launchd on macOS, systemd --user on Linux) so one bridge always owns the
# device. Idempotent; re-run any time.
.PHONY: install uninstall service-restart service-logs
install: bridge-install ## Install: deps + register MCP (http) + background service
	cd bridge && node scripts/setup.js

uninstall: ## Stop + remove the background service and the MCP registration
	cd bridge && node scripts/setup.js --uninstall

service-restart: ## Restart the background bridge service
	@case "$$(uname)" in \
	  Darwin) launchctl kickstart -k gui/$$(id -u)/com.co-copilot.bridge && echo "restarted (launchd)";; \
	  Linux)  systemctl --user restart co-copilot-bridge.service && echo "restarted (systemd)";; \
	  *) echo "Unsupported platform";; \
	esac

service-logs: ## Tail the background bridge service logs
	@case "$$(uname)" in \
	  Darwin) tail -f "$$HOME/Library/Logs/co-copilot-bridge.log";; \
	  Linux)  journalctl --user -u co-copilot-bridge.service -f;; \
	  *) echo "Unsupported platform";; \
	esac

flash: build ## Build, then OTA-flash the local firmware to the device over BLE
	cd bridge && node src/index.js --flash ../$(FIRMWARE_BIN)

flash-release: ## OTA-flash a published release bin over BLE (usage: make flash-release VERSION=x.y.z)
	@test -n "$(VERSION)" || { echo "Usage: make flash-release VERSION=x.y.z"; exit 1; }
	@set -eu; \
	tag="firmware-v$(VERSION)"; \
	repo="vkorotchenko/co-copilot"; \
	current="co-copilot-firmware-$(VERSION).bin"; \
	legacy="co-mpanion-firmware-$(VERSION).bin"; \
	assets=$$(gh release view "$$tag" --repo "$$repo" --json assets --jq '.assets[].name'); \
	if printf '%s\n' "$$assets" | grep -Fqx "$$current"; then \
		asset="$$current"; \
		echo "Using release asset $$asset"; \
	elif printf '%s\n' "$$assets" | grep -Fqx "$$legacy"; then \
		asset="$$legacy"; \
		echo "Current asset $$current is unavailable; using legacy asset $$asset"; \
	else \
		echo "Error: release $$tag has neither $$current nor $$legacy." >&2; \
		exit 1; \
	fi; \
	mkdir -p dist; \
	output="dist/$$asset"; \
	gh release download "$$tag" --repo "$$repo" \
		--pattern "$$asset" --output "$$output" --clobber; \
	cd bridge && node src/index.js --flash "../$$output"

# ---- release --------------------------------------------------------------
# Auto-detects the next version from the latest `firmware-v*` tag, creates an
# annotated tag, and pushes it. CI does the actual build + publish.
.PHONY: release-firmware-patch release-firmware-minor release-firmware-major
release-firmware-patch: ## Tag+push a patch release (firmware-vX.Y.Z+1)
	@$(MAKE) --no-print-directory _release BUMP=patch
release-firmware-minor: ## Tag+push a minor release (firmware-vX.Y+1.0)
	@$(MAKE) --no-print-directory _release BUMP=minor
release-firmware-major: ## Tag+push a major release (firmware-vX+1.0.0)
	@$(MAKE) --no-print-directory _release BUMP=major

.PHONY: _release
_release:
	@if ! git diff --quiet || ! git diff --cached --quiet; then \
		echo "Error: Working tree is dirty. Commit or stash changes before tagging a release."; \
		exit 1; \
	fi
	@git fetch origin >/dev/null 2>&1 || true
	@if ! git merge-base --is-ancestor HEAD origin/master 2>/dev/null; then \
		echo "Error: HEAD is ahead of origin/master. Push your commits first."; \
		exit 1; \
	fi
	@latest=$$(git tag -l 'firmware-v*' | sort -V | tail -n 1); \
	if [ -z "$$latest" ]; then \
		case "$(BUMP)" in \
			patch) next="0.0.1";; \
			minor) next="0.1.0";; \
			major) next="1.0.0";; \
		esac; \
	else \
		ver=$${latest#firmware-v}; \
		major=$$(echo $$ver | awk -F. '{print $$1}'); \
		minor=$$(echo $$ver | awk -F. '{print $$2}'); \
		patch=$$(echo $$ver | awk -F. '{print $$3}'); \
		case "$(BUMP)" in \
			patch) next="$$major.$$minor.$$((patch + 1))";; \
			minor) next="$$major.$$((minor + 1)).0";; \
			major) next="$$((major + 1)).0.0";; \
		esac; \
	fi; \
	tag="firmware-v$$next"; \
	if git rev-parse -q --verify "refs/tags/$$tag" >/dev/null; then \
		echo "Error: Tag $$tag already exists. Aborting."; \
		exit 1; \
	fi; \
	echo "Releasing firmware v$$next..."; \
	git tag -a "$$tag" -m "co-copilot firmware v$$next" && \
	git push origin "$$tag" && \
	echo "Tagged and pushed $$tag — CI will build and publish the release."
