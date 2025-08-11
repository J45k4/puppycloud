import SwiftUI
import AVFoundation
#if canImport(UIKit)
import UIKit

struct QRScannerView: View {
    var onResult: (String) -> Void
    var onCancel: () -> Void

    @State private var authorized = false
    @State private var session = AVCaptureSession()
    @State private var didHandle = false
    @State private var cameraUnavailable = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            CameraPreview(session: $session)
                .ignoresSafeArea()
                .background(Color.black)

            HStack {
                Button("Cancel") { onCancel() }
                    .padding(10)
                    .background(.ultraThinMaterial, in: Capsule())
                Spacer()
            }
            .padding()
        }
        .task { await setupCamera() }
        .onDisappear { session.stopRunning() }
    }

    @MainActor
    private func setupCamera() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            authorized = true
        case .notDetermined:
            let ok = await AVCaptureDevice.requestAccess(for: .video)
            authorized = ok
        default:
            authorized = false
        }
        guard authorized else { return }

        let newSession = AVCaptureSession()
        newSession.beginConfiguration()
        defer { newSession.commitConfiguration() }

        // Prefer back camera, but fall back to any available camera on Mac
        let preferredBack = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        let anyVideo = AVCaptureDevice.default(for: .video)
        let preferredFront = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
        guard let device = preferredBack ?? anyVideo ?? preferredFront else {
            cameraUnavailable = true
            return
        }
        guard let input = try? AVCaptureDeviceInput(device: device), newSession.canAddInput(input) else {
            cameraUnavailable = true
            return
        }
        newSession.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard newSession.canAddOutput(output) else { return }
        newSession.addOutput(output)
        output.setMetadataObjectsDelegate(DelegateProxy { [weak _session = newSession] meta in
            guard !didHandle else { return }
            for m in meta {
                if let code = m as? AVMetadataMachineReadableCodeObject,
                   code.type == .qr,
                   let value = code.stringValue {
                    didHandle = true
                    DispatchQueue.main.async {
                        onResult(value)
                        _session?.stopRunning()
                    }
                    break
                }
            }
        }, queue: DispatchQueue(label: "qr.meta"))
        output.metadataObjectTypes = [.qr]

        session = newSession
        session.startRunning()
    }
}

private final class DelegateProxy: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    private let handler: ([AVMetadataObject]) -> Void
    init(_ handler: @escaping ([AVMetadataObject]) -> Void) {
        self.handler = handler
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        handler(metadataObjects)
    }
}

private struct CameraPreview: UIViewRepresentable {
    @Binding var session: AVCaptureSession
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = UIScreen.main.bounds
        view.layer.addSublayer(layer)
        return view
    }
    func updateUIView(_ uiView: UIView, context: Context) {
        (uiView.layer.sublayers?.first as? AVCaptureVideoPreviewLayer)?.session = session
    }
}

#else

// Fallback for platforms without UIKit (e.g., macOS preview)
struct QRScannerView: View {
    var onResult: (String) -> Void
    var onCancel: () -> Void
    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
            VStack(spacing: 12) {
                Text("QR scanner not available on this platform.")
                    .foregroundStyle(.white)
                Button("Close") { onCancel() }
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}

#endif
