# Konvoy — Shared C++ Core Build Configuration
#
# Builds the cross-platform C++ modules:
#   - Audio Engine (libopus wrapper, VAD, jitter buffer)
#   - Wire Protocol helpers (if needed in native)
#
# This CMakeLists.txt is used by:
#   - Android: Referenced in android/app/build.gradle via externalNativeBuild
#   - iOS: Sources added directly to Xcode project (or via CMake Xcode generator)

cmake_minimum_required(VERSION 3.18)
project(KonvoyCore CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ─── libopus ──────────────────────────────────────────────────────────────
# For Android: opus is built from source via NDK.
# For iOS: opus is provided via CocoaPods or pre-built framework.

# Option 1: If building opus from source (vendored)
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/opus/CMakeLists.txt")
    add_subdirectory(opus)
    set(OPUS_TARGET opus)
else()
    # Option 2: Find system/pre-built opus
    find_package(PkgConfig)
    if(PkgConfig_FOUND)
        pkg_check_modules(OPUS opus)
    endif()
    if(OPUS_FOUND)
        set(OPUS_TARGET PkgConfig::OPUS)
    else()
        # Fallback: expect opus headers/libs to be provided externally
        message(WARNING "libopus not found — ensure it's provided in the build environment")
        set(OPUS_TARGET "")
    endif()
endif()

# ─── Audio Engine Library ─────────────────────────────────────────────────

add_library(konvoy_audio STATIC
    audio/KonvoyAudioEngine.cpp
    audio/KonvoyAudioEngine.h
)

target_include_directories(konvoy_audio PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/audio
)

if(OPUS_TARGET)
    target_link_libraries(konvoy_audio PUBLIC ${OPUS_TARGET})
endif()

# Include opus headers (for both vendored and system)
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/opus/include")
    target_include_directories(konvoy_audio PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/opus/include
    )
endif()

# ─── Compiler Flags ───────────────────────────────────────────────────────

if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    # Android-specific optimizations
    target_compile_options(konvoy_audio PRIVATE
        -O2
        -fno-exceptions
        -fno-rtti
        -DANDROID
    )
elseif(CMAKE_SYSTEM_NAME STREQUAL "iOS" OR CMAKE_SYSTEM_NAME STREQUAL "Darwin")
    # iOS/macOS optimizations
    target_compile_options(konvoy_audio PRIVATE
        -O2
        -fembed-bitcode
    )
endif()
