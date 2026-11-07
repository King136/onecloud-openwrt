#
# homearena-node: 为玩客云(iStoreOS/OpenWrt musl) 交叉编译一个运行时 Node.js
# 目标包。OpenWrt 官方 node 包是 HOST_ONLY/BUILDONLY（仅用于交叉编译其它 node
# 模块），无法安装到设备，因此这里单独提供一个真正装进 rootfs 的目标包。
# 采用「自带依赖、静态链接 node 本体」策略（不 --shared-*），避免运行时共享库
# 与 ABI 问题；唯一外部运行时依赖是 libstdcpp（C++ 标准库）。
#
include $(TOPDIR)/rules.mk

PKG_NAME:=homearena-node
PKG_VERSION:=22.23.4
PKG_RELEASE:=1
PKG_HASH:=4dd79de8cdc85d65cb32f48a75aee1067bf00bf94b96ecc8e4c2f82f6f0272c2
NODEJS_BIN_SUM:=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406

PKG_SOURCE:=node-v$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://nodejs.org/dist/v$(PKG_VERSION)
PKG_BUILD_DIR:=$(BUILD_DIR)/node-v$(PKG_VERSION)
HOST_BUILD_DIR:=$(BUILD_DIR_HOST)/node-v$(PKG_VERSION)

PKG_MAINTAINER:=HomeArena
PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE

HOST_BUILD_DEPENDS:=python3/host python-setuptools/host
PKG_BUILD_DEPENDS:=python3/host python-setuptools/host
PKG_BUILD_PARALLEL:=1
PKG_INSTALL:=1
PKG_ASLR_PIE:=0

include $(INCLUDE_DIR)/host-build.mk
include $(INCLUDE_DIR)/package.mk

NODEJS_CPU:=$(subst aarch64,arm64,$(subst x86_64,x64,$(subst i386,ia32,$(ARCH))))

CONFIGURE_VARS:= \
	CC="$(TARGET_CC) $(TARGET_OPTIMIZATION)" \
	CXX="$(TARGET_CXX) $(TARGET_OPTIMIZATION)" \
	CC_host="$(HOSTCC)" \
	CXX_host="$(HOSTCXX)"

CONFIGURE_ARGS:= \
	--dest-cpu=$(NODEJS_CPU) \
	--dest-os=linux \
	--cross-compiling \
	--prefix=/usr \
	--with-intl=none \
	--without-npm \
	--without-corepack

HOST_CONFIGURE_VARS:=
HOST_CONFIGURE_ARGS:= \
	--dest-os=linux \
	--with-intl=none \
	--prefix=$(STAGING_DIR_HOSTPKG)

define Package/homearena-node
  SECTION:=lang
  CATEGORY:=Languages
  SUBMENU:=Node.js
  TITLE:=Runtime Node.js for HomeArena (musl/arm)
  URL:=https://nodejs.org/
  DEPENDS:=+libstdcpp
endef

define Package/homearena-node/description
  Node.js runtime (v$(PKG_VERSION)) cross-compiled for the target (musl/arm),
  bundled dependencies, installed at /usr/bin/node for HomeArena.
endef

# 宿主机预编译 node（x64）用于交叉编译期间的构建脚本执行
NODEJS_BIN:=node-v$(PKG_VERSION)-linux-x64.tar.gz

define Download/nodebin
	URL:=https://nodejs.org/download/release/v$(PKG_VERSION)/
	FILE:=$(NODEJS_BIN)
	HASH:=$(NODEJS_BIN_SUM)
endef

define Host/Prepare
	$(eval $(call Download,nodebin))
endef

define Host/Configure
	# nothing to do
endef

define Host/Compile
	# nothing to do
endef

define Host/Install
	rm -f $(1)/bin/npm $(1)/bin/npx $(1)/bin/corepack
	rm -rf $(1)/lib/node_modules/npm $(1)/lib/node_modules/corepack
	$(TAR) xvf $(DL_DIR)/$(NODEJS_BIN) -C $(1) --strip-components=1
	rm -f $(1)/{CHANGELOG.md,LICENSE,README.md}
endef

define Package/homearena-node/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/bin/node $(1)/usr/bin/
endef

$(eval $(call HostBuild))
$(eval $(call BuildPackage,homearena-node))
