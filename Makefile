.PHONY: bootstrap apply-system enable-services capture check install-packages

bootstrap:
	./scripts/bootstrap.sh

install-packages:
	./scripts/install-packages.sh

apply-system:
	./scripts/apply-system.sh

enable-services:
	./scripts/enable-services.sh

capture:
	./scripts/capture-system.sh

check:
	./scripts/check.sh
