---
title: Android MediaCodec 编解码器深度分析
description: 基于 AOSP16 源码的 MediaCodec 架构、状态机、缓冲区模型与错误处理全面分析
category: codec
type: analysis
aosp_version: AOSP16
tags:
  - codec
  - MediaCodec
  - OMX
  - Codec2
  - state-machine
  - buffer-management
pubDate: 2026-03-28
---

# Android MediaCodec 编解码器深度分析

> 基于 AOSP16 (android-16.0.0_r4) 源码分析

---

## 1. 整体架构

![MediaCodec架构图](/pics/pic_MediaCodec_Analysis/MediaCodec_Architecture.png)

MediaCodec 编解码器采用分层架构设计，从上到下分为：

| 层次 | 关键文件 | 职责 |
|------|---------|------|
| **Java API** | `frameworks/base/media/java/android/media/MediaCodec.java` | 应用接口，状态管理 |
| **JNI** | `frameworks/base/media/jni/android_media_MediaCodec.cpp` | Java-Native 桥接 |
| **Native Framework** | `frameworks/av/media/libstagefright/MediaCodec.cpp` | 核心状态机，资源管理，消息调度 |
| **Codec Base** | `ACodec.cpp` (OMX) / `CCodec.cpp` (Codec2) | 编解码器适配层 |
| **HAL** | OMX HAL / Codec2 HAL | 硬件抽象层 |

---

## 2. 接口调用流程

### 2.1 创建编解码器的三种方式

MediaCodec 提供三个静态工厂方法，定义在 `{AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2105-2141}`：

#### (1) createDecoderByType - 按 MIME 类型创建解码器

```java
// {AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2105}
public static MediaCodec createDecoderByType(@NonNull String type)
        throws IOException {
    return new MediaCodec(type, true /* nameIsType */, false /* encoder */);
}
```

**使用方式：**
```java
// 创建 H.264 视频解码器
MediaCodec decoder = MediaCodec.createDecoderByType("video/avc");

// 创建 AAC 音频解码器
MediaCodec decoder = MediaCodec.createDecoderByType("audio/mp4a-latm");
```

**支持的常用 MIME 类型：**

| 类别 | MIME 类型 | 说明 |
|------|----------|------|
| 视频 | `video/avc` | H.264/AVC |
| 视频 | `video/hevc` | H.265/HEVC |
| 视频 | `video/x-vnd.on2.vp8` | VP8 |
| 视频 | `video/x-vnd.on2.vp9` | VP9 |
| 视频 | `video/av01` | AV1 |
| 音频 | `audio/mp4a-latm` | AAC |
| 音频 | `audio/mpeg` | MP3 |
| 音频 | `audio/vorbis` | Vorbis |
| 音频 | `audio/opus` | Opus |
| 音频 | `audio/flac` | FLAC |

#### (2) createEncoderByType - 按 MIME 类型创建编码器

```java
// {AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2123}
public static MediaCodec createEncoderByType(@NonNull String type)
        throws IOException {
    return new MediaCodec(type, true /* nameIsType */, true /* encoder */);
}
```

**使用方式：**
```java
// 创建 H.264 视频编码器
MediaCodec encoder = MediaCodec.createEncoderByType("video/avc");

// 创建 AAC 音频编码器
MediaCodec encoder = MediaCodec.createEncoderByType("audio/mp4a-latm");
```

#### (3) createByCodecName - 按组件名创建（推荐方式）

```java
// {AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2138}
public static MediaCodec createByCodecName(@NonNull String name)
        throws IOException {
    return new MediaCodec(name, false /* nameIsType */, false /* encoder */);
}
```

**推荐的使用方式（配合 MediaCodecList）：**
```java
// 通过 MediaCodecList 查找最优编解码器
MediaCodecList codecList = new MediaCodecList(MediaCodecList.ALL_CODECS);
MediaFormat format = MediaFormat.createVideoFormat("video/avc", 1920, 1080);
String decoderName = codecList.findDecoderForFormat(format);

// 按名称精确创建
MediaCodec decoder = MediaCodec.createByCodecName(decoderName);
// 典型名称: "c2.android.avc.decoder" (软解), "c2.qti.avc.decoder" (硬解)
```

#### (4) 系统级 API：createByCodecNameForClient

```java
// {AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2163} (SystemApi, @hide)
public static MediaCodec createByCodecNameForClient(
        @NonNull String name, int clientPid, int clientUid) throws IOException
```

该方法为系统应用/服务代理创建 codec，资源抢占时使用 client 的优先级而非系统服务的优先级。

### 2.2 创建流程的 Native 实现

Java 构造函数调用 `native_setup()` -> JNI `android_media_MediaCodec_native_setup` -> Native `MediaCodec::init()`:

```
MediaCodec.java 构造函数
  └── native_setup(name, nameIsType, encoder, pid, uid)
        └── [JNI] android_media_MediaCodec.cpp
              └── JMediaCodec::JMediaCodec()
                    └── MediaCodec::CreateByType() 或 CreateByComponentName()
                          └── MediaCodec::init(name)
```

**`MediaCodec::init()` 核心流程** (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：2531-2668}`)：

```
1. mResourceManagerProxy->init()       // 初始化资源管理器
2. mGetCodecInfo(name, &mCodecInfo)    // 从 MediaCodecList 获取 codec 信息
3. mGetCodecBase(name, owner)          // 创建 CodecBase (ACodec/CCodec)
4. 创建 CodecLooper（视频编解码专用线程）
5. mCodec->setCallback(...)             // 设置回调通道
6. PostAndAwaitResponse(kWhatInit)      // 异步初始化并等待结果
7. 资源不足时自动重试 (kMaxRetry 次)：
   └── mResourceManagerProxy->reclaimResource() // 尝试回收其他进程资源
8. mResourceManagerProxy->notifyClientCreated()  // 通知资源管理器
```

---

## 3. 创建后初始化流程

### 3.1 状态机

![MediaCodec状态机](/pics/pic_MediaCodec_Analysis/MediaCodec_StateMachine.png)

Native 层定义了完整的状态枚举（通过 `stateString()` 可查看，`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：7806-7838}`）：

```
UNINITIALIZED  ──create()──>  INITIALIZED
     ^                            │
     │ reset()                    │ configure()
     │                            v
   ERROR  <──fatal error──  CONFIGURED
                                  │
                                  │ start()
                                  v
                              STARTING ──onStarted──> STARTED (Running)
                                                        │    ^
                                                 flush()│    │resume
                                                        v    │
                                                     FLUSHING──> FLUSHED
                                                                   │
                                  INITIALIZED <──onStopped── STOPPING <──stop()── STARTED
                                       
                                  UNINITIALIZED <──onReleased── RELEASING <──release()── (任何状态)
```

**关键状态转换规则（摘自 `MediaCodec.cpp`）：**

- `CONFIGURED` 状态才能调用 `start()`（行 5785）
- `STARTED` 或 `FLUSHED` 状态才能执行 buffer 操作（行 4136）
- `flush()` 在异步模式下到达 `FLUSHED`，同步模式下回到 `STARTED`（行 5344-5346）
- 致命错误将状态设为 `UNINITIALIZED`（行 4629）
- 可恢复错误将状态设为 `INITIALIZED`（行 4621）

### 3.2 configure() 配置

`{AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2418-2571}` 定义了两个公开的 configure 重载：

```java
// 重载1：标准配置（带 MediaCrypto）
public void configure(
    @Nullable MediaFormat format,    // 媒体格式
    @Nullable Surface surface,       // 输出 Surface（视频解码）
    @Nullable MediaCrypto crypto,    // DRM 加密对象
    @ConfigureFlag int flags         // 配置标志
)

// 重载2：带 Descrambler 配置
public void configure(
    @Nullable MediaFormat format,
    @Nullable Surface surface,
    @ConfigureFlag int flags,
    @Nullable MediaDescrambler descrambler
)
```

**配置标志（ConfigureFlag）：**

| 标志 | 值 | 说明 |
|------|---|------|
| `CONFIGURE_FLAG_ENCODE` | 1 | 配置为编码器 |
| `CONFIGURE_FLAG_USE_BLOCK_MODEL` | 2 | 使用 Block 模式（LinearBlock/HardwareBuffer） |
| `CONFIGURE_FLAG_USE_CRYPTO_ASYNC` | 4 | 异步加解密（安全解码器） |
| `CONFIGURE_FLAG_DETACHED_SURFACE` | 8 | 分离式 Surface 模式（AOSP16 新增） |

**视频解码器配置示例：**
```java
MediaFormat format = MediaFormat.createVideoFormat("video/avc", 1920, 1080);

// Surface 模式（推荐，硬件直接渲染，零拷贝）
decoder.configure(format, surface, null, 0);

// ByteBuffer 模式（可访问原始帧数据）
decoder.configure(format, null, null, 0);
```

**视频编码器配置示例：**
```java
MediaFormat format = MediaFormat.createVideoFormat("video/avc", 1920, 1080);
format.setInteger(MediaFormat.KEY_BIT_RATE, 6_000_000);
format.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);

encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
```

**Native configure 流程** (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：2830-2960}`)：
```
1. 构建配置消息，包含 metricsHandle
2. 计算初始帧率
3. 声明所需资源 (CodecResource + GraphicMemoryResource)
4. 循环尝试 (kMaxRetry):
   a. PostAndAwaitResponse(kWhatConfigure)
   b. 失败且为资源错误 → reclaimResource() → reset() → 重试
   c. 非资源错误 → 跳出循环
```

### 3.3 start() 启动

```java
decoder.start(); // 启动编解码器，进入 STARTED 状态
```

Native 层 `kWhatStart` 处理 (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：5774-5812}`)：
- 若当前 `FLUSHED` 状态：直接恢复为 `STARTED`，调用 `mCodec->signalResume()`
- 若当前 `CONFIGURED` 状态：设置为 `STARTING`，调用 `mCodec->initiateStart()`
- 其他状态：返回 `INVALID_OPERATION`

### 3.4 缓冲区管理流程

![缓冲区流转](/pics/pic_MediaCodec_Analysis/MediaCodec_BufferFlow.png)

#### 同步模式（Legacy）

```java
// === 输入端 ===
int inputIndex = codec.dequeueInputBuffer(timeoutUs);  // 获取空闲输入缓冲区
if (inputIndex >= 0) {
    ByteBuffer inputBuf = codec.getInputBuffer(inputIndex);
    int size = /* 填充压缩数据到 inputBuf */;
    codec.queueInputBuffer(inputIndex, 0, size, presentationTimeUs, flags);
}

// === 输出端 ===
MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
int outputIndex = codec.dequeueOutputBuffer(info, timeoutUs);
if (outputIndex >= 0) {
    ByteBuffer outputBuf = codec.getOutputBuffer(outputIndex);
    // 处理解码后数据...
    codec.releaseOutputBuffer(outputIndex, render);  // render=true 渲染到 Surface
} else if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
    MediaFormat newFormat = codec.getOutputFormat();
}
```

#### 异步模式（推荐）

```java
codec.setCallback(new MediaCodec.Callback() {
    @Override
    public void onInputBufferAvailable(MediaCodec mc, int index) {
        ByteBuffer inputBuf = mc.getInputBuffer(index);
        // 填充数据...
        mc.queueInputBuffer(index, 0, size, pts, flags);
    }

    @Override
    public void onOutputBufferAvailable(MediaCodec mc, int index,
            MediaCodec.BufferInfo info) {
        ByteBuffer outputBuf = mc.getOutputBuffer(index);
        // 处理输出...
        mc.releaseOutputBuffer(index, true);
    }

    @Override
    public void onError(MediaCodec mc, MediaCodec.CodecException e) {
        // 错误处理
    }

    @Override
    public void onOutputFormatChanged(MediaCodec mc, MediaFormat format) {
        // 输出格式变更
    }
});

codec.configure(format, surface, null, 0);
codec.start();  // 回调将自动触发
```

---

## 4. 创建失败处理

### 4.1 失败场景与异常类型

创建编解码器时可能抛出的异常：

| 异常类型 | 触发场景 | 源码位置 |
|---------|---------|---------|
| `IOException` | codec 不存在或无法创建 | `{AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2100,2134}` |
| `IllegalArgumentException` | 无效的 MIME 类型或名称 | `{AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2101,2134}` |
| `NullPointerException` | type/name 参数为 null | `{AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2102,2135}` |

### 4.2 Native 层失败原因

`MediaCodec::init()` (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：2531-2668}`) 可能返回的错误码：

| 错误码 | 原因 | 说明 |
|--------|------|------|
| `NO_INIT` | ResourceManager 初始化失败 | 系统服务异常 |
| `NAME_NOT_FOUND` | 未找到 codec 信息 | MediaCodecList 中不存在该名称 |
| `NAME_NOT_FOUND` | CodecBase 创建失败 | HAL 层无对应组件 |
| 资源错误 | 硬件编解码器已被占满 | 触发 reclaimResource 机制 |

### 4.3 失败恢复策略

```java
MediaCodec codec = null;
try {
    // 优先尝试硬件解码器
    codec = MediaCodec.createByCodecName(hardwareDecoderName);
} catch (IOException e) {
    try {
        // 降级到软件解码器
        codec = MediaCodec.createByCodecName(softwareDecoderName);
    } catch (IOException e2) {
        try {
            // 最终降级：按类型创建（系统自动选择）
            codec = MediaCodec.createDecoderByType(mimeType);
        } catch (IOException e3) {
            // 所有方式都失败，提示用户设备不支持
            Log.e(TAG, "无法创建编解码器", e3);
        }
    }
}
```

---

## 5. 资源抢占机制

![资源抢占流程](/pics/pic_MediaCodec_Analysis/MediaCodec_ResourceReclaim.png)

### 5.1 架构概述

AOSP 通过 `ResourceManagerService` 管理编解码器资源。核心组件定义在 `{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：346-770}`：

```
MediaCodec
  └── ResourceManagerServiceProxy (行 415-770)
        ├── init()                  // 连接 ResourceManagerService
        ├── addResource()           // 注册资源
        ├── removeResource()        // 释放资源
        ├── reclaimResource()       // 请求回收资源
        ├── notifyClientCreated()   // 通知 codec 创建
        ├── notifyClientStarted()   // 通知 codec 启动
        └── notifyClientStopped()   // 通知 codec 停止
  
  └── ResourceManagerClient (行 349-408)
        └── reclaimResource()       // 被系统回收时的回调
```

### 5.2 资源类型

资源在 `init()` 和 `configure()` 时声明 (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：2643-2645, 2919-2926}`)：

```cpp
// init() 时声明编解码器资源
resources.push_back(MediaResource::CodecResource(
    secureCodec,                           // 是否安全解码器
    toMediaResourceSubType(mIsHardware,    // 硬件/软件
                           mDomain)));     // 视频/音频/图像

// configure() 时追加图形内存资源（视频/图像编解码）
if (mDomain == DOMAIN_VIDEO || mDomain == DOMAIN_IMAGE) {
    resources.push_back(MediaResource::GraphicMemoryResource(1));
}
```

### 5.3 抢占流程

**触发条件：** `init()` 或 `configure()` 因资源不足失败时

**抢占循环** (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：2647-2660}`)：
```cpp
for (int i = 0; i <= kMaxRetry; ++i) {
    if (i > 0) {
        // 第二次开始尝试回收
        if (!mResourceManagerProxy->reclaimResource(resources)) {
            break;  // 回收失败，放弃
        }
    }
    sp<AMessage> response;
    err = PostAndAwaitResponse(msg, &response);
    if (!isResourceError(err)) {
        break;  // 成功或非资源错误
    }
}
```

**回收策略（ResourceManagerService 端）：**
1. 根据进程 `oom_score_adj`（OOM 分数）确定优先级
2. 前台应用（oom_score 低）优先级高于后台应用
3. 回收优先级最低进程持有的同类型资源
4. 通过 `ResourceManagerClient::reclaimResource()` 回调通知被回收方

**被回收方处理** (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：349-408}`)：
```cpp
Status reclaimResource(bool* _aidl_return) override {
    // 1. 通知 ResourceManagerService 标记为待移除
    service->markClientForPendingRemoval(clientInfo);
    
    // 2. 释放 codec
    sp<MediaCodec> codec = mMediaCodec.promote();
    if (codec != nullptr) {
        status_t err = codec->reclaim();  // 内部调用 release(reclaimed=true)
    }
}
```

### 5.4 被抢占后的应用层表现

当 codec 被系统回收时，应用层会收到：
- **异步模式：** `Callback.onError()` 收到 `CodecException`，errorCode 为 `ERROR_RECLAIMED` (1101)
- **同步模式：** 下一次 API 调用抛出 `CodecException`，包含 `DEAD_OBJECT` 错误
- 对应 Native 层 `{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：5861-5868}` 中设置 `mReleasedByResourceManager = true`

### 5.5 AOSP16 新增：GlobalResourceInfo（资源查询）

AOSP16 新增了全局资源查询 API（`{AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2336-2378}`, TestApi）：

```java
// 查询全局编解码器资源
List<GlobalResourceInfo> resources = MediaCodec.getGlobalResourceInfo();
for (GlobalResourceInfo info : resources) {
    String name = info.getName();       // 资源类型名
    long capacity = info.getCapacity(); // 总容量
    long available = info.getAvailable(); // 可用数量
}
```

---

## 6. 异常处理逻辑

### 6.1 异常处理体系

MediaCodec 异常体系包含两个核心异常类：

**CodecException** (`{AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2851-2926}`)：

```java
public final static class CodecException extends IllegalStateException {
    // 错误分类
    private final static int ACTION_TRANSIENT = 1;    // 瞬态错误，可重试
    private final static int ACTION_RECOVERABLE = 2;  // 可恢复，需 stop→configure→start
    // 其他为 FATAL                                    // 致命错误，需 release 重建

    // 资源相关错误码
    public static final int ERROR_INSUFFICIENT_RESOURCE = 1100;
    public static final int ERROR_RECLAIMED = 1101;

    public boolean isTransient();     // ACTION_TRANSIENT
    public boolean isRecoverable();   // ACTION_RECOVERABLE
    public int getErrorCode();
    public String getDiagnosticInfo();
}
```

**CryptoException** (`{AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2931-3051}`)：DRM 加密操作错误

### 6.2 Native 层错误处理状态转换

`kWhatError` 消息处理 (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：4477-4676}`) 根据当前状态和 actionCode 决定目标状态：

| 当前状态 | ACTION_TRANSIENT | ACTION_RECOVERABLE | ACTION_FATAL |
|---------|-----------------|-------------------|--------------|
| **INITIALIZING** | - | - | -> UNINITIALIZED |
| **CONFIGURING** | -> INITIALIZED | -> INITIALIZED | -> UNINITIALIZED |
| **STARTING** | -> CONFIGURED | -> CONFIGURED | -> UNINITIALIZED |
| **STARTED/FLUSHED** | 保持当前(sticky error) | -> INITIALIZED | -> UNINITIALIZED |
| **FLUSHING** | -> FLUSHED/STARTED | -> FLUSHED/STARTED | -> UNINITIALIZED |
| **STOPPING** | - | - | -> UNINITIALIZED (if MediaServer died) |
| **RELEASING** | 忽略，等待 shutdown | 忽略 | 忽略 |

**Sticky Error 机制** (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：4605-4606}`)：
```cpp
setStickyError(err);  // 记录错误，后续同步 API 调用将直接返回该错误
postActivityNotificationIfPossible(); // 唤醒阻塞的 dequeue 操作
cancelPendingDequeueOperations();     // 取消所有待处理的 dequeue
```

### 6.3 MediaServer 崩溃处理

当 MediaServer 进程崩溃时 (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：4487-4489}`)：
```cpp
if (err == DEAD_OBJECT) {
    mFlags |= kFlagSawMediaServerDie;
    mFlags &= ~kFlagIsComponentAllocated;
}
```

在 STOPPING/RELEASING 状态下检测到 MediaServer 死亡 (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：4556-4577}`)：
- 直接转入 `UNINITIALIZED` 状态（跳过正常的 STOPPING->INITIALIZED 路径）
- 清除组件名，释放所有挂起的回复

---

## 7. 错误码分析

![错误处理决策树](/pics/pic_MediaCodec_Analysis/MediaCodec_ErrorHandling.png)

### 7.1 MediaCodec Java 层错误码

#### CodecException 错误码

| 错误码 | 常量 | 值 | 触发原因 |
|--------|------|---|---------|
| ERROR_INSUFFICIENT_RESOURCE | `CodecException.ERROR_INSUFFICIENT_RESOURCE` | 1100 | 系统编解码器资源不足，无法分配 |
| ERROR_RECLAIMED | `CodecException.ERROR_RECLAIMED` | 1101 | 资源被 ResourceManager 回收 |

#### dequeueOutputBuffer 返回值

| 返回值 | 常量 | 值 | 含义 |
|--------|------|---|------|
| INFO_TRY_AGAIN_LATER | `MediaCodec.INFO_TRY_AGAIN_LATER` | -1 | 超时无可用缓冲区 |
| INFO_OUTPUT_FORMAT_CHANGED | `MediaCodec.INFO_OUTPUT_FORMAT_CHANGED` | -2 | 输出格式已变更 |
| INFO_OUTPUT_BUFFERS_CHANGED | `MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED` | -3 | 输出缓冲区已变更（已废弃） |

#### CryptoException 错误码

| 错误码 | 值 | 触发原因 |
|--------|---|---------|
| ERROR_NO_KEY | 1 | 找不到解密密钥 |
| ERROR_KEY_EXPIRED | 2 | 密钥已过期 |
| ERROR_RESOURCE_BUSY | 3 | 加密资源忙 |
| ERROR_INSUFFICIENT_OUTPUT_PROTECTION | 4 | 输出保护级别不够 |
| ERROR_SESSION_NOT_OPENED | 5 | DRM 会话未打开 |
| ERROR_UNSUPPORTED_OPERATION | 6 | 不支持的加密操作 |
| ERROR_INSUFFICIENT_SECURITY | 7 | 设备安全级别不够 |
| ERROR_FRAME_TOO_LARGE | 8 | 帧超过安全缓冲区大小 |
| ERROR_LOST_STATE | 9 | 设备休眠导致状态丢失 |

### 7.2 Native 层错误码

定义在 `MediaErrors.h` (`frameworks/av/media/libstagefright/include/media/stagefright/MediaErrors.h`)：

#### 基础媒体错误 (MEDIA_ERROR_BASE = -1000)

| 错误码 | 常量 | 值 | 含义 |
|--------|------|---|------|
| ERROR_ALREADY_CONNECTED | -1000 | 已连接 |
| ERROR_NOT_CONNECTED | -1001 | 未连接 |
| ERROR_UNKNOWN_HOST | -1002 | 未知主机 |
| ERROR_CANNOT_CONNECT | -1003 | 无法连接 |
| ERROR_IO | -1004 | IO 错误 |
| ERROR_CONNECTION_LOST | -1005 | 连接断开 |
| ERROR_MALFORMED | -1007 | 数据格式错误 |
| ERROR_OUT_OF_RANGE | -1008 | 超出范围 |
| ERROR_BUFFER_TOO_SMALL | -1009 | 缓冲区过小 |
| ERROR_UNSUPPORTED | -1010 | 不支持的操作 |
| ERROR_END_OF_STREAM | -1011 | 流结束 |

#### 信息码

| 码值 | 常量 | 值 | 含义 |
|------|------|---|------|
| INFO_FORMAT_CHANGED | -1012 | 格式已变更 |
| INFO_DISCONTINUITY | -1013 | 不连续 |
| INFO_OUTPUT_BUFFERS_CHANGED | -1014 | 输出缓冲区变更 |

#### 编解码器错误范围

| 范围 | 说明 |
|------|------|
| `0x80001000` - `0x9000FFFF` | Codec 特定错误码 (ERROR_CODEC_MIN ~ ERROR_CODEC_MAX) |

#### 系统错误码（Android Errors.h）

| 错误码 | 值 | 含义 | MediaCodec 场景 |
|--------|---|------|----------------|
| OK / NO_ERROR | 0 | 成功 | - |
| UNKNOWN_ERROR | -2147483648 (INT32_MIN) | 未知错误 | 通用错误兜底 |
| NO_INIT | -19 | 未初始化 | ResourceManager/MediaCodecList 不可用 |
| ALREADY_EXISTS | -17 | 已存在 | - |
| DEAD_OBJECT | -32 | 对端已死亡 | MediaServer 崩溃/资源被回收 |
| INVALID_OPERATION | -38 | 非法操作 | 在错误状态调用 API |
| NAME_NOT_FOUND | -2 | 名称未找到 | 编解码器不存在 |
| NO_MEMORY | -12 | 内存不足 | 缓冲区分配失败 |

### 7.3 JNI 层错误码映射

JNI 层 (`{AOSP16/frameworks/base/media/jni/android_media_MediaCodec.cpp：83-126}`) 定义了错误码映射：

```cpp
// dequeueBuffer 特殊返回值
DEQUEUE_INFO_TRY_AGAIN_LATER       = -1
DEQUEUE_INFO_OUTPUT_FORMAT_CHANGED  = -2
DEQUEUE_INFO_OUTPUT_BUFFERS_CHANGED = -3

// 事件类型
EVENT_CALLBACK                      = 1
EVENT_SET_CALLBACK                  = 2
EVENT_FRAME_RENDERED                = 3
EVENT_FIRST_TUNNEL_FRAME_READY      = 4

// CodecException actionCode 映射
gCodecActionCodes.codecActionTransient    -> ACTION_TRANSIENT (1)
gCodecActionCodes.codecActionRecoverable  -> ACTION_RECOVERABLE (2)

// CodecException errorCode 映射
gCodecErrorCodes.errorInsufficientResource -> ERROR_INSUFFICIENT_RESOURCE (1100)
gCodecErrorCodes.errorReclaimed            -> ERROR_RECLAIMED (1101)
```

---

## 8. 错误处理策略

### 8.1 错误分级处理

```java
codec.setCallback(new MediaCodec.Callback() {
    @Override
    public void onError(MediaCodec mc, MediaCodec.CodecException e) {
        if (e.isTransient()) {
            // === 瞬态错误：可直接重试 ===
            // 原因：临时资源不足、缓冲区暂时不可用
            // 策略：短暂等待后重试当前操作
            Log.w(TAG, "瞬态错误，即将重试: " + e.getDiagnosticInfo());
            retryAfterDelay(100); // 延迟重试

        } else if (e.isRecoverable()) {
            // === 可恢复错误：需要重新配置 ===
            // 原因：编解码器内部状态异常，但可恢复
            // 策略：stop -> configure -> start
            Log.w(TAG, "可恢复错误，重新配置: " + e.getDiagnosticInfo());
            try {
                mc.stop();
                mc.configure(format, surface, null, 0);
                mc.start();
            } catch (Exception ex) {
                // 恢复失败，降级处理
                handleFatalError(mc, e);
            }

        } else {
            // === 致命错误：需要释放并重建 ===
            handleFatalError(mc, e);
        }
    }
});
```

### 8.2 致命错误分类处理

```java
private void handleFatalError(MediaCodec mc, CodecException e) {
    int errorCode = e.getErrorCode();
    
    switch (errorCode) {
        case CodecException.ERROR_RECLAIMED:
            // 资源被回收：release 后重新创建
            Log.e(TAG, "编解码器被系统回收");
            mc.release();
            // 重新创建（可能再次触发抢占其他低优先级进程）
            recreateCodec();
            break;
            
        case CodecException.ERROR_INSUFFICIENT_RESOURCE:
            // 资源不足：尝试降级方案
            Log.e(TAG, "系统资源不足");
            mc.release();
            // 降级策略：
            // 1. 降低分辨率
            // 2. 切换到软件编解码器
            // 3. 减少同时使用的编解码器数量
            fallbackToLowerResolution();
            break;
            
        default:
            // 其他致命错误
            Log.e(TAG, "致命错误: " + e.getDiagnosticInfo());
            mc.release();
            notifyUser("播放出错，请重试");
            break;
    }
}
```

### 8.3 同步模式错误处理

```java
try {
    int index = codec.dequeueOutputBuffer(info, TIMEOUT_US);
    // ... 处理缓冲区
} catch (MediaCodec.CodecException e) {
    if (e.isRecoverable()) {
        // stop → configure → start
    } else {
        // release 并重建
    }
} catch (IllegalStateException e) {
    // 在错误的状态调用了 API
    // 检查 codec 是否还存活，必要时重建
}
```

### 8.4 最佳实践：完整的编解码器生命周期管理

```java
public class SafeCodecWrapper {
    private MediaCodec mCodec;
    private MediaFormat mFormat;
    private Surface mSurface;
    private static final int MAX_RETRY = 3;
    
    public boolean init(String mime, MediaFormat format, Surface surface) {
        mFormat = format;
        mSurface = surface;
        
        for (int retry = 0; retry < MAX_RETRY; retry++) {
            try {
                // 优先指定名称创建
                MediaCodecList list = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
                String name = list.findDecoderForFormat(format);
                if (name != null) {
                    mCodec = MediaCodec.createByCodecName(name);
                } else {
                    mCodec = MediaCodec.createDecoderByType(mime);
                }
                
                mCodec.setCallback(mCallback);
                mCodec.configure(format, surface, null, 0);
                mCodec.start();
                return true;
                
            } catch (IOException e) {
                Log.w(TAG, "创建失败，重试 " + retry, e);
                if (mCodec != null) {
                    mCodec.release();
                    mCodec = null;
                }
            } catch (MediaCodec.CodecException e) {
                Log.w(TAG, "配置/启动失败，重试 " + retry, e);
                if (mCodec != null) {
                    mCodec.release();
                    mCodec = null;
                }
            }
        }
        return false;
    }
    
    public void release() {
        if (mCodec != null) {
            try {
                mCodec.stop();
            } catch (Exception e) {
                // stop 可能失败（已在错误状态），忽略
            }
            try {
                mCodec.release();
            } catch (Exception e) {
                // release 不应该失败，但做防护
            }
            mCodec = null;
        }
    }
}
```

---

## 8. 资源释放流程

### 8.1 正常释放步骤

```
STARTED ──stop()──> STOPPING ──onStopCompleted──> INITIALIZED ──release()──> RELEASING ──> UNINITIALIZED
```

**推荐的释放序列：**
```java
// 1. 发送 EOS（编码器场景）
codec.signalEndOfInputStream();  // Surface 模式
// 或
codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);

// 2. 等待输出端 EOS
// 在 Callback 中检查 BUFFER_FLAG_END_OF_STREAM

// 3. 停止编解码器
codec.stop();   // STARTED -> STOPPING -> INITIALIZED

// 4. 释放资源
codec.release(); // INITIALIZED -> RELEASING -> UNINITIALIZED
```

### 8.2 Native 层 release 流程

**stop 处理** (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：5815-5821, 5247-5278}`)：
```
kWhatStop:
  1. 设置目标状态为 INITIALIZED
  2. setState(STOPPING)
  3. mCodec->initiateShutdown(keepComponentAllocated=true)
  
kWhatStopCompleted:
  1. resourceManagerProxy->removeResource(GraphicMemoryResource)
  2. setState(INITIALIZED)
```

**release 处理** (`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：5822-5996, 5296-5340}`)：
```
kWhatRelease:
  1. 设置目标状态为 UNINITIALIZED
  2. stopCryptoAsync()
  3. 若被资源管理器回收：设置 mReleasedByResourceManager
  4. setState(RELEASING)
  5. mCodec->initiateShutdown(keepComponentAllocated=false)
  
kWhatReleaseCompleted:
  1. setState(UNINITIALIZED)
  2. resourceManagerProxy->removeClient()  // 从 ResourceManager 注销
  3. mCodec->release()                      // 释放底层组件
  4. mReleaseSurface = true                 // 标记 Surface 可释放
```

### 8.3 setState(UNINITIALIZED) 清理操作

`{AOSP16/frameworks/av/media/libstagefright/MediaCodec.cpp：6734-6788}` 中 setState 的清理逻辑：

```cpp
void MediaCodec::setState(State newState) {
    if (newState == INITIALIZED || newState == UNINITIALIZED) {
        // 清理渲染器
        delete mSoftRenderer; mSoftRenderer = NULL;
        // 清理加密对象
        mCrypto.clear();
        mDescrambler.clear();
        // 清理 Surface
        handleSetSurface(NULL);
        // 清理格式
        mInputFormat.clear();
        mOutputFormat.clear();
        // 清理标志位
        mFlags &= ~kFlagOutputFormatChanged;
        mFlags &= ~kFlagStickyError;
        mFlags &= ~kFlagIsEncoder;
        mFlags &= ~kFlagIsAsync;
        mStickyError = OK;
        // 清理回调
        mActivityNotify.clear();
        mCallback.clear();
        mErrorLog.clear();
    }
    
    if (newState == UNINITIALIZED) {
        // 归还所有滞留的缓冲区
        returnBuffersToCodec();
        // 清除 MediaServer 死亡标记
        mFlags &= ~kFlagSawMediaServerDie;
    }
    
    mState = newState;
    // 取消所有挂起的 dequeue 操作
    cancelPendingDequeueOperations();
}
```

### 8.4 异常场景的释放

```java
// 场景1：在错误状态下释放
try {
    codec.stop();
} catch (IllegalStateException e) {
    // 已在错误状态，stop 失败正常
} finally {
    codec.release();  // release() 在任何状态都可调用
}

// 场景2：忘记释放（不推荐，依赖 GC）
// {AOSP16/frameworks/base/media/java/android/media/MediaCodec.java：2198}
@Override
protected void finalize() {
    native_finalize();  // GC 时自动释放 native 资源
    mCrypto = null;
}
// 注意：不要依赖 finalize()，硬件编解码器数量有限，
// 不及时释放会导致其他应用无法使用

// 场景3：确保释放的 try-with-resources 模式
// MediaCodec 未实现 AutoCloseable，需手动管理
```

### 8.5 常见资源泄漏陷阱

| 陷阱 | 后果 | 解决方案 |
|------|------|---------|
| 只调 stop 不调 release | codec 组件仍占用，计入全局资源 | 始终配对调用 stop + release |
| 异常路径未释放 | 硬件编解码器被耗尽 | 在 finally 块中释放 |
| Activity 切换未释放 | 后台占用资源被系统回收 | 在 onPause/onStop 中释放 |
| 依赖 GC 释放 | 释放时机不确定，资源饥饿 | 主动调用 release() |

---

## 附录：关键源码路径索引

| 文件 | 路径 | 关键内容 |
|------|------|---------|
| MediaCodec.java | `frameworks/base/media/java/android/media/MediaCodec.java` | Java API, 状态文档, 异常定义 |
| android_media_MediaCodec.cpp | `frameworks/base/media/jni/android_media_MediaCodec.cpp` | JNI 桥接, 错误码映射 |
| MediaCodec.cpp | `frameworks/av/media/libstagefright/MediaCodec.cpp` | 核心状态机, 资源管理, 消息处理 |
| ACodec.cpp | `frameworks/av/media/libstagefright/ACodec.cpp` | OMX 适配层 |
| MediaErrors.h | `frameworks/av/media/libstagefright/include/media/stagefright/MediaErrors.h` | Native 错误码定义 |
| CCodec.cpp | `frameworks/av/media/codec2/sfplugin/CCodec.cpp` | Codec2 适配层 |
