import QtQuick.Layouts

Item {
    anchors.fill: parent

    ColumnLayout {
        width: 390
        spacing: 10

        Pane {
            Layout.preferredWidth: 390
            padding: 12

            background: Rectangle {
                color: theme.background2
                radius: 8
            }

            ColumnLayout {
                anchors.fill: parent
                spacing: 9

                Text {
                    color: theme.primarytextcolor
                    text: "Razer Key Light Chroma"
                    font.family: theme.primaryfont
                    font.weight: Font.Bold
                    font.pixelSize: 18
                }

                Text {
                    Layout.preferredWidth: 360
                    color: theme.secondarytextcolor
                    wrapMode: Text.Wrap
                    text: "The included PowerShell 7 helper reads the real Windows adapter prefix length and verifies Key Lights on TCP 10003. Do not run Synapse or the original Python controller at the same time."
                }

                RowLayout {
                    Layout.preferredWidth: 360
                    spacing: 8

                    SButton {
                        Layout.fillWidth: true
                        label.text: "Auto Discover"
                        onClicked: discovery.requestAutoDiscovery()
                    }

                    SButton {
                        color: hovered ? Qt.darker("#531B1B", 1.5) : "#531B1B"
                        label.text: "Clear Saved"
                        onClicked: discovery.clearSavedKeyLights()
                    }
                }

                Text {
                    Layout.preferredWidth: 360
                    color: theme.secondarytextcolor
                    wrapMode: Text.Wrap
                    text: discovery.scanStatus
                    font.family: theme.secondaryfont
                    font.pixelSize: 11
                }
            }
        }

        Pane {
            Layout.preferredWidth: 390
            padding: 12

            background: Rectangle {
                color: theme.background2
                radius: 8
            }

            ColumnLayout {
                anchors.fill: parent
                spacing: 8

                Text {
                    color: theme.primarytextcolor
                    text: "Optional CIDR scan"
                    font.family: theme.primaryfont
                    font.weight: Font.Bold
                    font.pixelSize: 14
                }

                Text {
                    Layout.preferredWidth: 360
                    color: theme.secondarytextcolor
                    wrapMode: Text.Wrap
                    text: "Use this to scan one explicit range, such as 192.168.0.0/16. Wider ranges can take several minutes."
                }

                RowLayout {
                    Layout.preferredWidth: 360
                    spacing: 8

                    TextField {
                        id: cidrAddress
                        Layout.fillWidth: true
                        placeholderText: "192.168.0.0/16"
                        color: theme.primarytextcolor
                        font.family: theme.secondaryfont

                        background: Rectangle {
                            color: theme.background3
                            radius: 4
                        }
                    }

                    SButton {
                        label.text: "Scan"
                        onClicked: discovery.scanCidr(cidrAddress.text)
                    }
                }
            }
        }

        Pane {
            Layout.preferredWidth: 390
            padding: 12

            background: Rectangle {
                color: theme.background2
                radius: 8
            }

            ColumnLayout {
                anchors.fill: parent
                spacing: 8

                Text {
                    color: theme.primarytextcolor
                    text: "Manual address"
                    font.family: theme.primaryfont
                    font.weight: Font.Bold
                    font.pixelSize: 14
                }

                RowLayout {
                    Layout.preferredWidth: 360
                    spacing: 8

                    TextField {
                        id: ipAddress
                        Layout.fillWidth: true
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

                    SButton {
                        label.text: "Add Light"
                        onClicked: {
                            discovery.addKeyLight(ipAddress.text)
                            ipAddress.text = ""
                        }
                    }
                }
            }
        }

        Repeater {
            model: service.controllers

            delegate: Pane {
                Layout.preferredWidth: 390
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
                        text: "TCP " + keyLight.ip + ":10003"
                        font.family: theme.secondaryfont
                    }
                }
            }
        }
    }
}
