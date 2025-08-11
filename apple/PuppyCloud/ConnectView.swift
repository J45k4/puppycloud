import SwiftUI

fileprivate func isValidUrl(_ text: String) -> Bool {
    guard let url = URL(string: text) else { return false }
    return url.scheme != nil && url.host != nil
}

struct ConnectView: View {
    @State private var serverUrl: String = ""
    @State private var apiToken: String = ""
    @State private var connecting: Bool = false
    @State private var showToken: Bool = false
    @State private var useQr: Bool = false

    var scannedText: String?
    var onScannedTextConsumed: () -> Void = {}
    var onScanQr: () -> Void = {}

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Connect to Server").font(.title2).bold()

                HStack {
                    Text("Scan QR from another peer")
                    Spacer()
                    Toggle("", isOn: $useQr).labelsHidden()
                }

                if !useQr {
                    VStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Server URL").font(.subheadline).foregroundStyle(.secondary)
                            TextField("https://example.local:8443", text: $serverUrl)
#if canImport(UIKit)
                                .textInputAutocapitalization(.never)
                                .textContentType(.URL)
                                .keyboardType(.URL)
                                .autocorrectionDisabled()
#endif
                                .padding(10)
#if canImport(UIKit)
                                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
#else
                                .background(Color.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
#endif
                            if !serverUrl.isEmpty && !isValidUrl(serverUrl) {
                                Text("Enter a valid URL with scheme, e.g. https://host:port")
                                    .font(.footnote)
                                    .foregroundStyle(.red)
                            }
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("API Token (optional)").font(.subheadline).foregroundStyle(.secondary)
                            HStack(spacing: 8) {
                                Group {
                                    if showToken {
                                        TextField("token", text: $apiToken)
#if canImport(UIKit)
                                            .textInputAutocapitalization(.never)
                                            .autocorrectionDisabled()
#endif
                                    } else {
                                        SecureField("token", text: $apiToken)
                                    }
                                }
                                .padding(10)
#if canImport(UIKit)
                                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
#else
                                .background(Color.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
#endif

                                Button(showToken ? "Hide" : "Show") { showToken.toggle() }
                            }
                        }

                        Button {
                            guard isValidUrl(serverUrl) else { return }
                            connecting = true
                            // TODO: Wire to networking / Rust layer
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                                connecting = false
                            }
                        } label: {
                            HStack {
                                if connecting { ProgressView().padding(.trailing, 8) }
                                Text("Connect")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(connecting || !isValidUrl(serverUrl))

                        Text("Your server URL is never shared. Token is optional.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Button("Scan QR Code") { onScanQr() }
                        .buttonStyle(.borderedProminent)
                        .frame(maxWidth: .infinity)
                    Text("Scan a QR code exported from another device to import server settings.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)
        }
        .onChange(of: scannedText) { _, text in
            guard let text, !text.isEmpty else { return }
            // Try direct URL
            if isValidUrl(text) {
                serverUrl = text
                onScannedTextConsumed()
                return
            }
            // Try extracting url/token from query string
            if let comps = URLComponents(string: text) {
                let pairs = comps.queryItems ?? []
                if let urlParam = pairs.first(where: { $0.name == "url" })?.value, isValidUrl(urlParam) {
                    serverUrl = urlParam
                }
                if let tokenParam = pairs.first(where: { $0.name == "token" })?.value, !tokenParam.isEmpty {
                    apiToken = tokenParam
                }
                if !(pairs.isEmpty) { onScannedTextConsumed() }
            }
        }
        .navigationTitle("Connect")
    }
}

struct ConnectView_Previews: PreviewProvider {
    static var previews: some View {
        ConnectView(scannedText: nil)
    }
}
