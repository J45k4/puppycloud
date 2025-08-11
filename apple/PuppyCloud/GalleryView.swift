import SwiftUI
import Photos
import AVKit
#if canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
#endif

enum MediaItem: Identifiable, Hashable {
    case photo(id: String, asset: PHAsset)
    case video(id: String, asset: PHAsset)

    var id: String {
        switch self {
        case .photo(let id, _): return id
        case .video(let id, _): return id
        }
    }
}

struct GalleryView: View {
    @State private var authorized: Bool = false
    @State private var loading: Bool = true
    @State private var items: [MediaItem] = []
    @State private var selected: MediaItem? = nil

    private let grid = [GridItem(.adaptive(minimum: 120), spacing: 6)]
    private var isPreview: Bool { ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1" }

    var body: some View {
        ZStack {
            if isPreview {
                VStack(spacing: 12) {
                    Text("Preview placeholder: Gallery").foregroundStyle(.secondary)
                }
            } else if !authorized {
                VStack(spacing: 12) {
                    Text("Storage permission required to show gallery.")
                        .foregroundStyle(.secondary)
                    Button("Request Access") { Task { await requestPhotosAccess() } }
                        .buttonStyle(.borderedProminent)
                }
            } else if loading {
                ProgressView().controlSize(.large)
            } else {
                ScrollView {
                    LazyVGrid(columns: grid, spacing: 6) {
                        ForEach(items) { item in
                            MediaGridItem(item: item) { selected = item }
                        }
                    }
                    .padding(6)
                }
            }
        }
        .task { if !isPreview { await setup() } }
#if canImport(UIKit)
        .fullScreenCover(item: $selected) { item in
            FullscreenViewer(item: item) { selected = nil }
        }
#else
        .sheet(item: $selected) { item in
            FullscreenViewer(item: item) { selected = nil }
        }
#endif
        .navigationTitle("Gallery")
    }

    private func setup() async {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            await requestPhotosAccess()
        } else {
            authorized = (status == .authorized || status == .limited)
        }
        if authorized { await loadMedia() }
    }

    @MainActor
    private func requestPhotosAccess() async {
        let newStatus = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        authorized = (newStatus == .authorized || newStatus == .limited)
        if authorized { await loadMedia() }
    }

    @MainActor
    private func loadMedia() async {
        loading = true
        items.removeAll()

        let fetchOptions = PHFetchOptions()
        fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let all = PHAsset.fetchAssets(with: fetchOptions)
        var result: [MediaItem] = []
        all.enumerateObjects { asset, _, _ in
            switch asset.mediaType {
            case .image:
                result.append(.photo(id: asset.localIdentifier, asset: asset))
            case .video:
                result.append(.video(id: asset.localIdentifier, asset: asset))
            default:
                break
            }
        }
        items = result
        loading = false
    }
}

private struct MediaGridItem: View {
    let item: MediaItem
    var onTap: () -> Void

    var body: some View {
        ZStack {
            switch item {
            case .photo(_, let asset):
                AssetThumbnail(asset: asset)
            case .video(_, let asset):
                AssetThumbnail(asset: asset)
                    .overlay(alignment: .center) {
                        Text("▶").font(.title).bold().foregroundStyle(.white).shadow(radius: 2)
                    }
            }
        }
        .frame(height: 120)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
    }
}

private struct AssetThumbnail: View {
    let asset: PHAsset
    @State private var image: PlatformImage? = nil

    var body: some View {
        ZStack {
            if let image {
                platformImageView(image)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle().fill(Color.gray.opacity(0.2))
                ProgressView()
            }
        }
        .onAppear { requestThumbnail() }
    }

    private func requestThumbnail() {
        let manager = PHCachingImageManager.default()
        let size = CGSize(width: 300, height: 300)
        let options = PHImageRequestOptions()
        options.isSynchronous = false
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        manager.requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: options) { img, _ in
            self.image = img
        }
    }
}

private struct FullscreenViewer: View {
    let item: MediaItem
    var onDismiss: () -> Void
    @State private var uiImage: PlatformImage? = nil
    @State private var playerItem: AVPlayerItem? = nil

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            switch item {
            case .photo(_, let asset):
                Group {
                    if let img = uiImage {
                        platformImageView(img).resizable().scaledToFit()
                    } else {
                        ProgressView().tint(.white)
                    }
                }
                .task { await requestFullImage(asset: asset) }
            case .video(_, let asset):
                Group {
                    if let item = playerItem {
                        VideoPlayer(player: AVPlayer(playerItem: item))
                            .onAppear { AVPlayer(playerItem: item).play() }
                    } else {
                        ProgressView().tint(.white)
                    }
                }
                .task { await requestPlayerItem(asset: asset) }
            }
            Button("Close") { onDismiss() }
                .buttonStyle(.bordered)
                .tint(.white)
                .padding()
        }
    }

    @MainActor
    private func requestFullImage(asset: PHAsset) async {
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.isSynchronous = false
        options.version = .current
        PHCachingImageManager.default().requestImage(for: asset, targetSize: PHImageManagerMaximumSize, contentMode: .aspectFit, options: options) { img, _ in
            self.uiImage = img
        }
    }

    @MainActor
    private func requestPlayerItem(asset: PHAsset) async {
        let options = PHVideoRequestOptions()
        options.deliveryMode = .automatic
        PHCachingImageManager.default().requestPlayerItem(forVideo: asset, options: options) { item, _ in
            self.playerItem = item
        }
    }
}

// Helper to convert PlatformImage to SwiftUI.Image
@inline(__always)
private func platformImageView(_ image: PlatformImage) -> Image {
#if canImport(UIKit)
    return Image(uiImage: image)
#else
    return Image(nsImage: image)
#endif
}

struct GalleryView_Previews: PreviewProvider {
    static var previews: some View {
        GalleryView()
    }
}
