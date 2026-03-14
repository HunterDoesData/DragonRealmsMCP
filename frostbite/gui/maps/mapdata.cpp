#include "mapdata.h"
#include "maps/mapreader.h"
#include "maps/mapnode.h"
#include "maps/mapzone.h"
#include "maps/mapdestination.h"

#include <algorithm>

namespace {
QString roomKey(const QString& zoneId, int nodeId) {
    return zoneId + ":" + QString::number(nodeId);
}

bool isMapFileToken(const QString& note) {
    return note.trimmed().endsWith(".xml", Qt::CaseInsensitive);
}

QString normalizeToken(const QString& value) {
    QString normalized = value.trimmed().toLower();
    normalized.replace("'", "");
    normalized.replace("\"", "");
    normalized.replace("`", "");
    normalized.replace(QRegExp("[^a-z0-9]+"), " ");
    normalized = normalized.simplified();
    return normalized;
}

struct CandidateLink {
    QString zoneId;
    int nodeId;
    int score;
};

QList<CandidateLink> resolveUnspecifiedArcTargets(
    MapZone* currentZone,
    MapNode* currentNode,
    const QString& unresolvedMove,
    const QMap<QString, MapZone*>& zones,
    const QHash<QString, QString>& fileToZone
) {
    QList<CandidateLink> results;
    if (currentZone == NULL || currentNode == NULL) {
        return results;
    }

    QSet<QString> targetZoneIds;
    QSet<QString> bridgeNotes;

    const QStringList currentNotes = currentNode->getNotes();
    for (const QString& rawNote : currentNotes) {
        const QString note = rawNote.trimmed();
        if (note.isEmpty()) {
            continue;
        }

        if (isMapFileToken(note)) {
            const QString zoneId = fileToZone.value(note);
            if (!zoneId.isEmpty()) {
                targetZoneIds.insert(zoneId);
            }
            continue;
        }

        bridgeNotes.insert(normalizeToken(note));
    }

    if (targetZoneIds.isEmpty()) {
        return results;
    }

    const QString currentZoneFile = normalizeToken(currentZone->getFile());
    const QString currentName = normalizeToken(currentNode->getName());
    const QString unresolved = normalizeToken(unresolvedMove);

    QSet<QString> currentDesc;
    const QStringList currentDescList = currentNode->getDesc();
    for (const QString& desc : currentDescList) {
        const QString normalized = normalizeToken(desc);
        if (!normalized.isEmpty()) {
            currentDesc.insert(normalized);
        }
    }

    for (const QString& targetZoneId : targetZoneIds) {
        MapZone* targetZone = zones.value(targetZoneId);
        if (targetZone == NULL) {
            continue;
        }

        const auto targetNodes = targetZone->getNodes();
        for (MapNode* candidate : targetNodes) {
            if (candidate == NULL) {
                continue;
            }

            int score = 0;

            const QString candidateName = normalizeToken(candidate->getName());
            if (!currentName.isEmpty() && !candidateName.isEmpty()) {
                if (candidateName == currentName) {
                    score += 100;
                } else if (candidateName.contains(currentName) || currentName.contains(candidateName)) {
                    score += 20;
                }
            }

            QSet<QString> candidateBridge;
            QSet<QString> candidateMapFiles;

            const QStringList candidateNotes = candidate->getNotes();
            for (const QString& rawNote : candidateNotes) {
                const QString note = rawNote.trimmed();
                if (note.isEmpty()) {
                    continue;
                }

                if (isMapFileToken(note)) {
                    candidateMapFiles.insert(normalizeToken(note));
                } else {
                    candidateBridge.insert(normalizeToken(note));
                }
            }

            if (!currentZoneFile.isEmpty() && candidateMapFiles.contains(currentZoneFile)) {
                score += 80;
            }

            int bridgeOverlap = 0;
            for (const QString& bridge : bridgeNotes) {
                if (candidateBridge.contains(bridge)) {
                    bridgeOverlap++;
                }
            }
            score += bridgeOverlap * 15;

            int descOverlap = 0;
            const QStringList candidateDescList = candidate->getDesc();
            for (const QString& desc : candidateDescList) {
                const QString normalized = normalizeToken(desc);
                if (!normalized.isEmpty() && currentDesc.contains(normalized)) {
                    descOverlap++;
                }
            }
            score += descOverlap * 30;

            if (!unresolved.isEmpty()) {
                QMultiHash<int, MapDestination*>& candidateDestinations = candidate->getDestinations();
                const QList<MapDestination*> destinationValues = candidateDestinations.values();
                for (MapDestination* destination : destinationValues) {
                    if (destination == NULL) {
                        continue;
                    }

                    QString move = destination->getMove().trimmed();
                    if (move.isEmpty()) {
                        move = destination->getExit().trimmed();
                    }

                    if (normalizeToken(move) == unresolved) {
                        score += 8;
                        break;
                    }
                }
            }

            if (score > 0) {
                CandidateLink match;
                match.zoneId = targetZoneId;
                match.nodeId = candidate->getId();
                match.score = score;
                results.append(match);
            }
        }
    }

    std::sort(results.begin(), results.end(), [](const CandidateLink& a, const CandidateLink& b) {
        if (a.score != b.score) {
            return a.score > b.score;
        }
        if (a.zoneId != b.zoneId) {
            return a.zoneId < b.zoneId;
        }
        return a.nodeId < b.nodeId;
    });

    if (results.isEmpty()) {
        return results;
    }

    const int topScore = results.first().score;
    if (topScore < 20) {
        return QList<CandidateLink>();
    }

    QList<CandidateLink> topMatches;
    for (const CandidateLink& candidate : results) {
        if (candidate.score == topScore) {
            topMatches.append(candidate);
            if (topMatches.size() >= 5) {
                break;
            }
        } else {
            break;
        }
    }

    return topMatches;
}
}

MapData::MapData(MapReader* parent) : QObject(parent) {
    mapReader = parent;
}

QString MapData::getZones() {
    return mapReader->getZones().keys().join(",");
}

void MapData::setRoom(const RoomNode& roomNode) {
    QWriteLocker locker(&lock);
    this->roomNode = roomNode;
}

const RoomNode& MapData::getRoom() const {
    QReadLocker locker(&lock);
    return this->roomNode;
}

RoomNode MapData::findLocation(QString note) {
    QHash<QString, RoomNode> locations = mapReader->getLocations();
    QHash<QString, RoomNode>::iterator i = locations.find(note);

    if(i == locations.end()) {
        return RoomNode();
    } else {
        return i.value();
    }
}

QString MapData::findPath(QString zoneId, int startId, int destId) {
    return this->findPath(zoneId, startId, zoneId, destId);
}

QString MapData::findPath(QString startZoneId, int startId, QString destZoneId, int destId) {
    return this->findPathDetailed(startZoneId, startId, destZoneId, destId, NULL, NULL);
}

QString MapData::findPathDetailed(QString startZoneId, int startId, QString destZoneId, int destId,
                                  int* inferredHopCount, QStringList* inferredSteps) {
    if (inferredHopCount != NULL) {
        *inferredHopCount = 0;
    }
    if (inferredSteps != NULL) {
        inferredSteps->clear();
    }

    QMap<QString, MapZone*> zones = mapReader->getZones();

    MapZone* startZone = zones.value(startZoneId);
    MapZone* finishZone = zones.value(destZoneId);
    if (startZone == NULL || finishZone == NULL) {
        return "";
    }

    if (!startZone->getNodes().contains(startId) || !finishZone->getNodes().contains(destId)) {
        return "";
    }

    const QString startKey = roomKey(startZoneId, startId);
    const QString finishKey = roomKey(destZoneId, destId);

    if (startKey == finishKey) {
        return "";
    }

    QHash<QString, QString> fileToZone;
    for (auto it = zones.constBegin(); it != zones.constEnd(); ++it) {
        MapZone* zone = it.value();
        if (zone != NULL) {
            fileToZone.insert(zone->getFile(), zone->getId());
        }
    }

    QQueue<QString> queue;
    QSet<QString> visited;
    QHash<QString, QString> previous;
    QHash<QString, QString> moveTaken;
    QHash<QString, bool> inferredTaken;

    queue.enqueue(startKey);
    visited.insert(startKey);

    while (!queue.isEmpty()) {
        const QString currentKey = queue.dequeue();
        if (currentKey == finishKey) {
            break;
        }

        const int sep = currentKey.indexOf(':');
        if (sep <= 0) {
            continue;
        }

        const QString currentZoneId = currentKey.left(sep);
        const int currentNodeId = currentKey.mid(sep + 1).toInt();

        MapZone* currentZone = zones.value(currentZoneId);
        if (currentZone == NULL) {
            continue;
        }

        MapNode* currentNode = currentZone->getNodes().value(currentNodeId);
        if (currentNode == NULL) {
            continue;
        }

        QMultiHash<int, MapDestination*>& destinations = currentNode->getDestinations();
        for (MapDestination* destination : destinations.values()) {
            if (destination == NULL) {
                continue;
            }

            QString move = destination->getMove().trimmed();
            if (move.isEmpty()) {
                move = destination->getExit().trimmed();
            }

            const int nextNodeId = destination->getDestId();
            if (nextNodeId > 0 && currentZone->getNodes().contains(nextNodeId)) {
                const QString nextKey = roomKey(currentZoneId, nextNodeId);
                if (visited.contains(nextKey)) {
                    continue;
                }

                visited.insert(nextKey);
                previous.insert(nextKey, currentKey);
                moveTaken.insert(nextKey, move);
                inferredTaken.insert(nextKey, false);
                queue.enqueue(nextKey);

                continue;
            }

            if (move.isEmpty()) {
                continue;
            }

            const QList<CandidateLink> inferredLinks = resolveUnspecifiedArcTargets(
                currentZone, currentNode, move, zones, fileToZone);

            for (const CandidateLink& inferred : inferredLinks) {
                const QString nextKey = roomKey(inferred.zoneId, inferred.nodeId);
                if (visited.contains(nextKey)) {
                    continue;
                }

                visited.insert(nextKey);
                previous.insert(nextKey, currentKey);
                moveTaken.insert(nextKey, move);
                inferredTaken.insert(nextKey, true);
                queue.enqueue(nextKey);
            }
        }
    }

    if (!visited.contains(finishKey)) {
        return "";
    }

    QStringList moves;
    QList<bool> inferredFlags;
    QString cursor = finishKey;
    while (cursor != startKey) {
        const QString move = moveTaken.value(cursor).trimmed();
        if (!move.isEmpty()) {
            moves.prepend(move);
            inferredFlags.prepend(inferredTaken.value(cursor, false));
        }
        cursor = previous.value(cursor);
        if (cursor.isEmpty()) {
            return "";
        }
    }

    int inferredCount = 0;
    for (int index = 0; index < inferredFlags.size(); ++index) {
        if (inferredFlags.at(index)) {
            inferredCount++;
            if (inferredSteps != NULL) {
                inferredSteps->append(QString::number(index + 1) + ": " + moves.at(index));
            }
        }
    }

    if (inferredHopCount != NULL) {
        *inferredHopCount = inferredCount;
    }

    return moves.join(",");
}

QList<MapNode*> MapData::getShortestPathBFS(QHash<int, MapNode*>& nodes, int startId, int finishId) {
    QList<int> ids = nodes.keys();

    QHash<int, bool> visited;
    foreach(int id, ids) visited.insert(id, false);

    QQueue<MapNode*> queue;

    visited.insert(startId, true);

    queue.push_back(nodes.value(startId));

    QHash<MapNode*, MapNode*> prev;

    MapNode* currentNode = NULL;
    while(!queue.isEmpty()) {
        currentNode = queue.front();

        if(currentNode->getId() == finishId) break;

        queue.pop_front();        

        QMultiHash<int, MapDestination* >& destinations = currentNode->getDestinations();

        QList<MapDestination*> values = destinations.values();
        for (int i = 0; i < values.size(); ++i) {
            int destId = values.at(i)->getDestId();
            if(!visited.value(destId) && destId != -1) {
                visited.insert(destId, true);

                MapNode* destNode = nodes.value(destId);                                                
                if(destNode != NULL) {
                    queue.push_back(destNode);
                    prev.insert(destNode, currentNode);
                }
            }
        }
    }

    MapNode* finish = nodes.value(finishId);

    if(finish == NULL || currentNode != finish) return QList<MapNode*>();

    QList<MapNode*> path;
    for(MapNode* node = finish; node != NULL; node = prev.value(node)) {
        path.push_front(node);
    }

    return path;
}

QStringList MapData::getMoves(QList<MapNode*> path) {
    QStringList moves;

    MapNode* prev = path.first();
    for(int i = 1; i < path.size(); ++i) {
        MapNode* current = path.value(i);
        QString move = prev->getDestinations().value(current->getId())->getMove();
        if(move.isEmpty()) {
            moves << prev->getDestinations().value(current->getId())->getExit();
        } else {
            moves << move;
        }
        prev = current;
    }
    return moves;
}

RoomNode MapData::findRoomNode(QString hash) {
    QList<RoomNode> nodes = mapReader->getRoomNodes().values(hash);
    if(nodes.isEmpty()) return RoomNode();
    return nodes.last();
}
