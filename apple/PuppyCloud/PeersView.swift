import SwiftUI

struct Peer: Identifiable, Hashable {
    let id: String
    let name: String
    let endpoint: String
    let status: String
}

struct PeersView: View {
    @State private var peers: [Peer] = [
        Peer(id: "1", name: "Laptop", endpoint: "10.0.0.5:8443", status: "Online"),
        Peer(id: "2", name: "Home Server", endpoint: "example.local:8443", status: "Offline")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Peers").font(.title2).bold()

            Button("Refresh") {
                // TODO: refresh real data later
            }
            .buttonStyle(.borderedProminent)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(peers) { peer in
                        Button(action: { /* onPeerClick */ }) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(peer.name).font(.headline)
                                Text(peer.endpoint).font(.subheadline).foregroundStyle(.secondary)
                                Text("Status: \(peer.status)").font(.footnote)
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 8)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .navigationTitle("Peers")
    }
}

struct PeersView_Previews: PreviewProvider {
    static var previews: some View {
        PeersView()
    }
}

