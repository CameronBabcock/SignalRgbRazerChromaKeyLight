import QtQuick
import QtQuick.Layouts

Item {
    anchors.fill: parent

    ColumnLayout {
        width: 352
        spacing: 10

        Pane {
            Layout.preferredWidth: 352
            padding: 10

            background: Rectangle {
                color: theme.background2
                radius: 8
            }

            ColumnLayout {
                anchors.fill: parent
                spacing: 8

                Text {
                    color: theme.primarytextcolor
                    text: "Razer Key Light Chroma"
                    font.family: theme.primaryfont
                    font.weight: Font.Bold
                    font.pixelSize: 18
                }

                RowLayout {
                    spacing: 6

                    Rectangle {
                        id: proxyDot
                        width: 10
                        height: 10
                        radius: 5
                        color: "#666666"
                    }

                    Text {
                        id: proxyStatus
                        color: theme.secondarytextcolor
                        font.family: theme.secondaryfont
                        text: "Checking for proxy…"
                    }

                    Timer {
                        interval: 2000
                        running: true
                        repeat: true
                        triggeredOnStart: true
                        onTriggered: {
                            proxyStatus.text = discovery.proxyStatusText()
                            proxyDot.color = discovery.proxyOnline() ? "#2ecc71" : "#e74c3c"
                        }
                    }
                }

                Text {
                    Layout.preferredWidth: 330
                    color: theme.secondarytextcolor
                    wrapMode: Text.Wrap
                    text: "Reserve each Key Light's address in your router, then add the IPv4 address here. The companion proxy (installed by install.ps1) relays colors to the light; do not run Synapse or the Python controller at the same time."
                }

                TextField {
                    id: ipAddress
                    Layout.preferredWidth: 330
                    placeholderText: "192.168.1.120"
                    color: theme.primarytextcolor
                    font.family: theme.secondaryfont

                    validator: RegularExpressionValidator {
                        regularExpression: /^((?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.){0,3}(?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])$/
                    }

                    background: Rectangle {
                        color: theme.background3
                        radius: 4
                    }
                }

                RowLayout {
                    Layout.alignment: Qt.AlignRight
                    spacing: 8

                    SButton {
                        label.text: "Add Light"
                        onClicked: {
                            discovery.addKeyLight(ipAddress.text)
                            ipAddress.text = ""
                        }
                    }

                    SButton {
                        color: hovered ? Qt.darker("#531B1B", 1.5) : "#531B1B"
                        label.text: "Clear Saved"
                        onClicked: discovery.clearSavedKeyLights()
                    }
                }
            }
        }

        Repeater {
            model: service.controllers

            delegate: Pane {
                Layout.preferredWidth: 352
                padding: 10

                property var keyLight: model.modelData.obj

                background: Rectangle {
                    color: theme.background2
                    radius: 8
                }

                ColumnLayout {
                    anchors.fill: parent
                    spacing: 3

                    Text {
                        color: theme.primarytextcolor
                        text: keyLight.name
                        font.family: theme.primaryfont
                        font.weight: Font.Bold
                        font.pixelSize: 15
                    }

                    Text {
                        color: theme.secondarytextcolor
                        text: "TCP " + keyLight.ip + ":10003 (via local proxy)"
                        font.family: theme.secondaryfont
                    }
                }
            }
        }
    }
}
