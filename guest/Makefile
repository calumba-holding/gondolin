.PHONY: build build-bins build-inner test clean run image image-inner kernel kernel-inner qemu lint typecheck format

RUN_PARALLEL ?= ../scripts/run-parallel

ZIG ?= zig
OPTIMIZE ?= ReleaseSmall
TSX ?= ../host/node_modules/.bin/tsx

ZIG_SOURCES := $(shell find src -name '*.zig') build.zig
ZIG_BUILD_DEPS := $(ZIG_SOURCES) build.zig.zon

IMAGE_SCRIPT ?= ./image/build.sh
IMAGE_OUT ?= ./image/out
IMAGE_INITRAMFS ?= $(IMAGE_OUT)/initramfs.cpio.lz4
IMAGE_ROOTFS ?= $(IMAGE_OUT)/rootfs.ext4
IMAGE_ROOTFS_INIT ?= ./image/init
IMAGE_INITRAMFS_INIT ?= ./image/initramfs-init
SANDBOXD_BIN ?= $(CURDIR)/zig-out/bin/sandboxd
SANDBOXFS_BIN ?= $(CURDIR)/zig-out/bin/sandboxfs

ALPINE_VERSION ?= 3.23.0
ALPINE_BRANCH ?= v$(shell echo $(ALPINE_VERSION) | cut -d. -f1,2)
ALPINE_MIRROR ?= https://dl-cdn.alpinelinux.org/alpine
KERNEL_PKG ?= linux-virt
KERNEL ?= $(IMAGE_OUT)/vmlinuz-virt

HOST_ARCH := $(shell uname -m)
HOST_OS := $(shell uname -s)
ifeq ($(HOST_OS),Darwin)
  ifeq ($(HOST_ARCH),x86_64)
    ifeq ($(shell sysctl -n hw.optional.arm64 2>/dev/null),1)
      HOST_ARCH := arm64
    endif
  endif
endif

ifeq ($(HOST_ARCH),arm64)
DEFAULT_ARCH := aarch64
DEFAULT_QEMU := qemu-system-aarch64
else ifeq ($(HOST_ARCH),aarch64)
DEFAULT_ARCH := aarch64
DEFAULT_QEMU := qemu-system-aarch64
else
DEFAULT_ARCH := x86_64
DEFAULT_QEMU := qemu-system-x86_64
endif

ALPINE_ARCH ?= $(DEFAULT_ARCH)
QEMU ?= $(DEFAULT_QEMU)
QEMU_MACHINE :=
ifeq ($(ALPINE_ARCH),aarch64)
QEMU_MACHINE := -machine virt
endif

QEMU_MEMORY ?= 256M
ifeq ($(ALPINE_ARCH),aarch64)
QEMU_MEMORY ?= 512M
endif
QEMU_SMP ?= 2
QEMU_SERIAL ?= stdio
QEMU_WAIT ?= on
VIRTIO_SOCK ?= $(IMAGE_OUT)/virtio.sock

build: image kernel

build-bins:
	@$(RUN_PARALLEL) -j 1 \
		"guest:build" "$(MAKE) build-inner"

build-inner:
	$(ZIG) build -Doptimize=$(OPTIMIZE)

run: build-bins
	./zig-out/bin/sandboxd

$(SANDBOXD_BIN): $(ZIG_BUILD_DEPS)
	$(ZIG) build -Doptimize=$(OPTIMIZE)

$(IMAGE_INITRAMFS) $(IMAGE_ROOTFS): $(SANDBOXD_BIN) $(SANDBOXFS_BIN) $(IMAGE_SCRIPT) $(IMAGE_ROOTFS_INIT) $(IMAGE_INITRAMFS_INIT)
	ARCH=$(ALPINE_ARCH) ALPINE_VERSION=$(ALPINE_VERSION) ALPINE_BRANCH=$(ALPINE_BRANCH) ROOTFS_INIT=$(IMAGE_ROOTFS_INIT) INITRAMFS_INIT=$(IMAGE_INITRAMFS_INIT) $(IMAGE_SCRIPT)

image:
	@$(RUN_PARALLEL) -j 1 \
		"guest:image" "$(MAKE) image-inner"

image-inner: $(IMAGE_INITRAMFS) $(IMAGE_ROOTFS)

kernel:
	@$(RUN_PARALLEL) -j 1 \
		"guest:kernel" "$(MAKE) kernel-inner"

kernel-inner:
	@set -e; \
		mkdir -p $(IMAGE_OUT); \
		if [ -f "$(KERNEL)" ]; then \
			echo "Kernel already present at $(KERNEL)"; \
			exit 0; \
		fi; \
		echo "Fetching $(KERNEL_PKG) from Alpine $(ALPINE_BRANCH) ($(ALPINE_ARCH))"; \
		index_url=$(ALPINE_MIRROR)/$(ALPINE_BRANCH)/main/$(ALPINE_ARCH)/APKINDEX.tar.gz; \
		if [ ! -f "$(IMAGE_OUT)/APKINDEX.tar.gz" ]; then \
			echo "Downloading $$index_url"; \
			curl -L -o "$(IMAGE_OUT)/APKINDEX.tar.gz" "$$index_url"; \
		fi; \
		tar -xzf "$(IMAGE_OUT)/APKINDEX.tar.gz" -C "$(IMAGE_OUT)" APKINDEX; \
		ver=$$(awk '/^P:$(KERNEL_PKG)$$/{p=1} p&&/^V:/{print substr($$0,3); exit}' "$(IMAGE_OUT)/APKINDEX"); \
		rm -f "$(IMAGE_OUT)/APKINDEX"; \
		if [ -z "$$ver" ]; then \
			echo "failed to determine $(KERNEL_PKG) version" >&2; \
			exit 1; \
		fi; \
		apk_url="$(ALPINE_MIRROR)/$(ALPINE_BRANCH)/main/$(ALPINE_ARCH)/$(KERNEL_PKG)-$$ver.apk"; \
		echo "Downloading $$apk_url"; \
		curl -L -o "$(IMAGE_OUT)/$(KERNEL_PKG).apk" "$$apk_url"; \
		tar -xzf "$(IMAGE_OUT)/$(KERNEL_PKG).apk" -C "$(IMAGE_OUT)" boot/vmlinuz-virt; \
		mv "$(IMAGE_OUT)/boot/vmlinuz-virt" "$(KERNEL)"; \
		rm -rf "$(IMAGE_OUT)/boot"

qemu: image kernel
	@rm -f $(VIRTIO_SOCK)
	$(QEMU) $(QEMU_MACHINE) \
		-nodefaults -no-reboot -m $(QEMU_MEMORY) -smp $(QEMU_SMP) \
		-kernel $(KERNEL) \
		-initrd $(IMAGE_INITRAMFS) \
		-drive file=$(IMAGE_ROOTFS),format=raw,if=none,id=drive0,snapshot=on \
		-device virtio-blk-pci,drive=drive0 \
		-append "console=ttyS0 initramfs_async=1" \
		-nographic \
		-serial $(QEMU_SERIAL) \
		-object rng-random,filename=/dev/urandom,id=rng0 \
		-device virtio-rng-pci,rng=rng0 \
		-chardev socket,id=virtiocon0,path=$(VIRTIO_SOCK),server=on,wait=$(QEMU_WAIT) \
		-device virtio-serial-pci \
		-device virtserialport,chardev=virtiocon0,name=virtio-port

format:
	$(ZIG) fmt $(ZIG_SOURCES)

lint:
	$(ZIG) fmt --check $(ZIG_SOURCES)

typecheck: build-bins


test: image kernel
	$(ZIG) build test-bins -Doptimize=$(OPTIMIZE)
	$(TSX) ../host/bin/guest-tests.ts

clean:
	rm -rf zig-cache zig-out $(IMAGE_OUT)
