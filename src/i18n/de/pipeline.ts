import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'Die Rekonstruktion verwendet verschiebbare Bildebenen und geometrische Bedingungen für Wiederbesuche bereits erfasster Bereiche. Automatische Masken und die Erkennung dynamischer Bereiche beruhen auf Heuristiken. Konfidenzwerte sind keine kalibrierten Wahrscheinlichkeiten für ein korrektes Ergebnis. Konsistenzvergleiche verwenden das für diese Quelle angegebene Dekodierrauschen von ±{{noise}} Stufen{{margin}}.',
      marginLossy: ' (Toleranz für Kompressionsartefakte und Farbrekonstruktion)',
      marginLossless: ' (verlustfreie Quelle, exakter Pixelvergleich)',
      action:
        'Unvereinbare Maßstäbe oder Strukturen bleiben als unabhängige Fragmente erhalten, statt zwangsweise zusammengesetzt zu werden.',
    },
    APPROXIMATE_DECODER: {
      message:
        '„Näherungsweise · nativer Player“ mit {{fps}} Hz wurde ausdrücklich aktiviert. Nicht jedes Videobild wird garantiert erfasst; kurz sichtbare Inhalte können fehlen.',
      action: 'Wenn jedes einzelne Videobild erfasst werden muss, verwende eine von WebCodecs unterstützte Quelle, etwa H.264 oder VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'Die Bewegungsanalyse begrenzt die lange Kante auf {{size}} px. Verfeinerung und endgültiges Zusammensetzen nutzen die Originalpixel. Die Ausgabe wird daher nicht verkleinert.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Ein Videobild in Originalgröße und seine Referenzbilder schöpfen das gewählte Cache-Limit fast aus. Das JavaScript-Limit kontrolliert den Speicher von Codec und GPU nicht.',
      action:
        'Die Ausgabeauflösung wird nie stillschweigend reduziert. Bei Speichermangel bleiben bereits gespeicherte Daten erhalten und der Fehler wird gemeldet.',
    },
    RUN_FAILURE: {
      action:
        'Bereits lokal gespeicherte Kacheln bleiben sichtbar und exportierbar. Der fehlgeschlagene Lauf wurde nicht als erfolgreich markiert.',
    },
    PERSISTENCE_ERROR: {
      action: 'Auch das Schreiben in den Speicher ist fehlgeschlagen. Nur zuvor gespeicherte Daten lassen sich wiederherstellen.',
    },
    MEMORY_BUDGET_RAISED: {
      message:
        'Der Kachel-Cache wurde von den erlaubten {{from}} auf {{to}} Kacheln erhöht, etwa {{mb}} MB. So passen alle Kacheln hinein, die ein einzelnes Videobild berührt.',
      action:
        'Ein kleinerer Cache würde dazu führen, dass für jedes Videobild alle betroffenen Kacheln erneut dekodiert und kodiert werden. Eine niedrigere Aufnahmeauflösung senkt den Speicherbedarf.',
    },
    NONFINITE_POSE: {
      message:
        'Die Positionsberechnung hat einen nicht endlichen Wert geliefert. Diese Beobachtung wurde isoliert; ungültige Koordinaten wurden nicht in die Bildfläche geschrieben.',
    },
    MISSING_PLAN: {
      message: 'In der Renderphase fehlt plan/{{index}}. Die Verarbeitung wurde nach dem bereits gespeicherten Teil beendet.',
      action:
        'Prüfe die Integrität des lokalen Speichers. Ein fehlender Positionierungsplan wird nie stillschweigend als leere Beobachtung behandelt.',
    },
    prefixOnly: {
      base: {
        scan: 'Positionierung und Zusammensetzen werden nur mit den bisher dekodierten Videobildern fortgesetzt ({{frames}})',
        solve: 'Das Rendern wird nur mit den bisher positionierten Videobildern fortgesetzt ({{frames}})',
        render: 'Nur die bisher gerenderten Videobilder bleiben im Ergebnis erhalten ({{frames}})',
      },
      suffixPersistence: '; das Schreiben in den Speicher wurde beendet.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action:
        'Die gerahmte Ansicht wurde für diese Bildfläche übersprungen. Die eigentliche Rekonstruktion in Seitenkoordinaten bleibt unverändert.',
    },
    PRESENTATION_FRAME: {
      message:
        'Gerahmte Ansicht und ursprünglicher 2D-Inhalt bleiben getrennt erhalten. Der Rahmen stammt aus einem Referenzbild. Erweiterte Flächen sind nur dekorativer Hintergrund und gelten nicht als beobachteter Inhalt. Symbole werden weder gestreckt noch vervielfacht. Andere Bereiche innerhalb des Rahmens sind nur Referenzansichten.',
    },
    PRESENTATION_STAGE_FAILED: {
      action:
        'Die gerahmte Ansicht konnte nicht erstellt werden. Ergebnis und Status der eigentlichen Rekonstruktion in Seitenkoordinaten bleiben unverändert.',
    },
    PYRAMID_FAILED: {
      action: 'Die Vorschaustufen konnten nicht erstellt werden. Kacheln in Originalgröße bleiben unverändert, sichtbar und exportierbar.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message:
        'Die Phase {{pass}} hat nur {{actual}} von {{expected}} Videobildern abgeschlossen. Das Ergebnis wurde als unvollständig markiert.',
      action:
        'Der erfolgreich gespeicherte Teil bleibt erhalten. Fehlende Videobilder werden nie stillschweigend als verarbeitet gewertet.',
    },
    FRAME_CONVERSION: {
      message: 'Dekodierte Videobilder werden so in Pixel umgewandelt: {{method}}.',
    },
    HDR_UNCHECKED: {
      message:
        'Dies ist eine HDR-Aufnahme ({{transfer}}). Der Browser bietet jedoch keine Möglichkeit, die Farbumwandlung zu prüfen. Das Ergebnis kann deshalb zu dunkel oder ausgewaschen wirken.',
      action: 'Versuche es erneut mit einer aktuellen Version von Chrome oder Safari.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'Im ersten Bild dieser HDR-Aufnahme sind {{percent}} % der Pixel heller als gewöhnliches Weiß und wurden als Weiß übernommen. Wirkt das Ergebnis überbelichtet, hat der Rekorder gewöhnliches Weiß vermutlich auf eine höhere Helligkeit gesetzt.',
      action: 'Setze das SDR-Weiß des Rekorders auf 100 Nits zurück oder schalte HDR-Aufnahmen aus.',
    },
    SLOW_CONVERSION: {
      message:
        'Dieser Browser benötigt etwa {{ms}} ms, um jedes Videobild dieser Aufnahme in Pixel umzuwandeln. Allein die Konvertierung dauert damit ungefähr {{minutes}} min.',
      action:
        'Aktuelle Versionen von Chrome oder Safari sind deutlich schneller. Auch das vorherige Umwandeln der Aufnahme in H.264 kann helfen.',
    },
    REVEAL_SKIPPED: {
      message:
        'Dieses Ergebnis enthält zu viele oder zu große Bildflächen. Das Entfernen von Überlagerungen wie Mauszeiger, schwebenden Schaltflächen und Scrollleisten würde etwa {{need}} MB mehr benötigen, als noch verfügbar sind. Dieser Schritt wurde übersprungen; die zusammengesetzten Pixel bleiben erhalten.',
      action:
        'Das übrige Ergebnis ist unverändert. Viele Bildflächen bedeuten meist, dass Teile der Aufnahme nicht an vorherige Inhalte angeschlossen werden konnten. Eine kürzere Aufnahme oder ein Computer mit mehr Arbeitsspeicher kann helfen.',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}. Rust-Kern: Variante {{variant}}, Rechenthreads: {{threads}} ({{coreReason}}).',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: 'Die gerahmte Ansicht wird übersprungen. Die eigentliche Rekonstruktion in Seitenkoordinaten bleibt unverändert.',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'Das Bild enthält zu wenige erkennbare Merkmale. Identische leere Bilder können eine Pause oder eine Bewegung über eine leere Fläche zeigen. Anhand der Pixel allein lässt sich das nicht unterscheiden.',
      action: 'Nimm erkennbare Inhalte oder mehr Überlappung auf. Eine Verschiebung von null ist hier nur eine Schätzung.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Diese Beobachtung bietet keine verlässlichen visuellen Anhaltspunkte für die Ausrichtung. Die Positionierungsphase versucht einen Abgleich mit früheren Bildern. Gelingt das nicht, bleibt ein unabhängiges Fragment erhalten.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Ein wiederholtes Muster erlaubt mehrere gleich plausible Zuordnungen. Die Bewegungskontinuität hilft bei der Schätzung, beweist aber keine eindeutige Position.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message:
        'Dieses Videobild deckt eine ungewöhnlich lange Zeitspanne ab. Bei schneller Bewegung können Bereiche durchlaufen worden sein, die nie aufgenommen wurden.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'Bereiche außerhalb der manuell markierten Regionen bleiben als unabhängige Beobachtungsebene mit geringer Konfidenz in Bildschirmkoordinaten erhalten. Ihre Position auf der Seite gilt nicht als rekonstruiert.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Ein als „Ignorieren“ markierter Bereich wurde wie eingestellt ausgeschlossen. Er trägt nichts zur Rekonstruktion bei. Es wurden keine Videobilder automatisch verworfen.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Bei überlappenden manuellen Bereichen hat der zuletzt gezeichnete Vorrang. Ignorierte Bereiche bleiben immer ausgeschlossen. Übrige Pixel werden in der nicht zugewiesenen Beobachtungsebene erhalten.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Automatische Erkennung — Inhaltsbereiche: {{moving}}; Bereiche mit fester Oberfläche: {{fixed}}. Die Grenzen ergeben sich aus der Pixelbewegung, nicht aus dem DOM.',
      action:
        'Wenn ein Bereich falsch zugeordnet ist, zeichne unter „Bewegungsbereiche“ den scrollbaren Bereich genau ein und starte erneut.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Jeder unabhängig scrollbare Bereich erhält eine eigene Bildfläche. Ihnen wird keine gemeinsame Verschiebung aufgezwungen.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Nach der Ausrichtung enthält die Überlappung insgesamt {{conflicts}} deutlich abweichende Pixel. Diese Region ist ein zusammenhängender Teil dieses Konflikts. Mögliche Ursachen sind Animation, Inhaltsänderungen, Layoutverschiebungen oder verbleibende Ausrichtungsfehler.',
      actionStable:
        'Der gesamte Konfliktbereich wurde nach Möglichkeit auf einen gemeinsamen Zeitpunkt festgelegt. Prüfe die orange markierten Diagnosen und den entsprechenden Zeitpunkt in der Originalaufnahme.',
      actionRolling:
        'Der gesamte Konfliktbereich wird nur dann aus demselben Videobild aktualisiert, wenn er vollständig sichtbar ist. Die ganze Seite zeigt dadurch keinen einheitlichen Zeitpunkt.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Dieser veränderte Bereich war nie vollständig in einem nutzbaren Bildausschnitt sichtbar. Daher stammen möglicherweise nicht alle seine Pixel vom selben Zeitpunkt.',
      action: 'Beobachteter Inhalt und ausdrückliche Konfliktmarkierungen bleiben erhalten. Nicht beobachtete Teile wurden nicht erfunden.',
    },
    MISSING_SCAN_RECORD: {
      message: 'In der Positionierungsphase fehlt scan/{{index}}. Die Verarbeitung wurde nach dem bereits gespeicherten Teil beendet.',
      action: 'Prüfe die Integrität des lokalen Speichers. Ein fehlender Scan-Eintrag wird nie als Verschiebung von null behandelt.',
    },
    GRAPH_RESIDUAL: {
      message:
        'Die größte verbleibende Abweichung im Positionsgraphen beträgt {{residual}} Originalpixel. Nahe Verbindungsstellen können geometrisch unstimmig sein.',
      action: 'Prüfe Texte und wiederholte Muster nahe dem wiederbesuchten Bereich. Diese Abweichung wurde nicht verborgen.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Etwa {{percent}} % der Texturblöcke folgen nicht der Gesamtbewegung, etwa durch Animation, Video, verzögertes Laden oder Layoutänderungen. Die Verschiebung wird aus den übereinstimmenden Blöcken bestimmt. Konfliktbereiche werden beim Zusammensetzen separat behandelt.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'Die Videobilder sind stark gegeneinander verschoben. Zur Ausrichtung bleibt nur wenig Überlappung. Die Verschiebung wird aus diesem kleinen Bereich geschätzt. Bei wiederholten Layouts könnte auch das benachbarte Muster dieselben Pixel erklären.',
      action:
        'Liefert ein späterer Wiederbesuch bessere Anhaltspunkte, wird dieser ganze Abschnitt der Bewegungsbahn korrigiert und die Korrektur protokolliert.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'Ein wiederholtes Muster lässt mehrere Verschiebungen zu. Verwendet wurde die am besten zur durchgehenden Bewegung passende Lösung. Sie ist eine Schätzung, nicht nachweislich die einzig richtige Ausrichtung.',
      messageLowConfidence:
        'Die Position dieses Bereichs wurde mit geringer Konfidenz geschätzt. Betroffene Pixel sind in der Qualitätsmaske markiert.',
      messageStatic:
        'Die beiden Bilder sind nahezu identisch, besitzen aber keine überprüfbare Merkmalszuordnung. Sie werden als Pause mit Verschiebung null behandelt. Das ist eine Schätzung.',
      action:
        'Die durchgehende Bewegungsbahn und vorhandene Anker dienen als Grundlage der Schätzung. Die Ausrichtung gilt nicht als eindeutig bestätigt.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Dieses Videobild enthält in diesem Bereich keine erkennbaren Merkmale. Ein leeres Bild könnte eine Pause oder Bewegung über eine leere Fläche zeigen; die Pixel allein unterscheiden das nicht. Es wird nirgends eingezeichnet.',
      action:
        'Wenn der Inhalt nach der leeren Fläche keine Überlappung mit früheren Beobachtungen hat, bleibt er als unabhängiges Fragment erhalten. Die dazwischenliegende Entfernung wird nicht geraten.',
    },
    RELOCALIZED: {
      message:
        'Ein früherer visueller Anker hat die Position auf einer bereits beobachteten Bildfläche wiederhergestellt. Der erneut besuchte Inhalt wurde nicht als zusätzliche Bildlänge angehängt.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Eine Änderung von Maßstab oder Layout um ungefähr {{scale}}× wurde erkannt. Sie bleibt als unabhängiges Fragment mit Originalpixeln erhalten. Eine Skalierung wurde nicht unbemerkt eingemischt.',
      action:
        'Die Beziehung zwischen den Fragmenten ist noch unbestätigt. Passt ein späterer Wiederbesuch zuverlässig, wird das Fragment als Ganzes angefügt. Nimm mit mehr Überlappung erneut auf oder grenze die veränderliche Komponente manuell ab.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'Die Position relativ zur ursprünglichen Bildfläche ließ sich nicht bestätigen. Der Inhalt bleibt als unabhängiges, separat exportierbares Fragment erhalten. Die Fragmente können sich überlappen oder tatsächlich durch eine Lücke getrennt sein.',
      action:
        'Die Beziehung zwischen den Fragmenten ist noch unbestätigt. Passt ein späterer Wiederbesuch zuverlässig, wird das Fragment als Ganzes angefügt. Nimm mit mehr Überlappung erneut auf oder grenze die veränderliche Komponente manuell ab.',
    },
    STICKY_OCCLUSION: {
      message:
        'Merkmale am oberen Bildrand deuten auf eine am Bildschirm fixierte Oberfläche statt auf Seitenbewegung hin. Diese Verdeckung wird nicht in die bewegte Bildfläche übernommen. Die ursprüngliche Oberfläche bleibt in der gerahmten Ansicht erhalten.',
    },
    NESTED_LAYER_FOUND: {
      message:
        'Ein Teil dieses Bereichs scrollt für sich: In {{frames}} Videobildern bewegte sich sein Inhalt nicht mit dem Bereich, deshalb erhält er ein eigenes Bild.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'Ein Wiederbesuch lieferte genügend Anhaltspunkte, um ein unabhängiges Fragment als Ganzes an eine bestehende Bildfläche anzufügen. Die relative Bewegungsbahn innerhalb des Fragments bleibt unverändert.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'Der vorherige Schritt hatte nur wenig Überlappung. Die Zuordnung dieses Bildes zu bereits beobachtetem Inhalt weicht um {{discrepancy}} px ab und ist besser belegt. Die aktuelle Position wurde entsprechend korrigiert.',
      action:
        'Die Korrektur betrifft dieses Videobild und die nachfolgende Bewegungsbahn. Zuvor geschriebene Pixel bleiben unverändert und können an den korrigierten Koordinaten einen sichtbaren Übergang bilden.',
    },
    LOOP_CLOSURE: {
      message:
        'Ein zuverlässiger Wiederbesuch wurde erkannt und als globale Positionsbedingung aufgenommen. Das endgültige Zusammensetzen verwendet die korrigierte Bewegungsbahn.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'Die Zuordnung zu früheren Bildern weicht um {{discrepancy}} px von der durchgehenden Bewegungsbahn ab. Die Anhaltspunkte widersprechen sich, daher wurde keine Schleifenschlussbedingung erzwungen.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'Die Suche in früheren Bildern lieferte mehrere fast gleich plausible Positionen. Der unsichere Wiederbesuch wurde nicht als feste Bedingung übernommen.',
    },
  },
  progress: {
    runPartial: 'Eine ausdrücklich als unvollständig markierte Rekonstruktion wurde gespeichert.',
    runComplete: 'Rekonstruktion abgeschlossen. Bitte Diagnosen und nicht beobachtete Bereiche prüfen.',
    render: 'Beobachtete Inhalte werden als Kacheln in Originalgröße zusammengesetzt. Lücken bleiben transparent.',
    reveal: {
      learn: 'Aufnahme erneut prüfen, um schwebende Schaltflächen, Eingabeleisten und Scrollleisten zu erkennen.',
      agree: 'Jeden Seitenbereich über die Zeit vergleichen. Eine unverdeckte Ansicht hat Vorrang.',
      relearn: 'Schwebende Elemente anhand der geprüften Seite erneut erkennen.',
      write: 'Verdeckte oder abweichende Bereiche durch ein unverdecktes Bild ersetzen.',
    },
    framingStart: 'Ursprünglichen Rahmen erhalten. Nur der Hintergrund wird erweitert, ohne Texte zu strecken oder Symbole zu verdoppeln.',
    pyramidBuild: 'Vorschaustufen auf dem Datenträger erstellen. Kacheln in Originalgröße bleiben unverändert.',
    scanFrame: 'Geometrische Anhaltspunkte Bild für Bild erfassen und unabhängige Bewegungsbereiche erkennen.',
    duplicateReuse: 'Eine identische Beobachtung übernimmt die vorherige Position. Quellbild und Zeitstempel bleiben erhalten.',
    solveFrame: 'Positionen pixelgenau verfeinern, mit früheren Bildern abgleichen und 2D-Schleifenschlüsse bestimmen.',
    optimizing: 'Positionsgraphen auf dem Datenträger optimieren und Drift bei Wiederbesuchen korrigieren.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: Dieser Browser kann den Codec dieser Aufnahme nicht dekodieren ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'iPhone und Mac nehmen meist in HEVC auf. Das unterstützen nur einige Browser. Nutze Safari oder Chrome beziehungsweise Edge mit Hardwaredekodierung.',
      prores: 'Kein Browser dekodiert ProRes. Exportiere die Aufnahme zuerst als H.264 oder HEVC.',
      h264: 'Diese H.264-Variante (4:4:4 oder 10 Bit) wird nur von Chrome dekodiert. Nutze Chrome oder exportiere als gewöhnliches H.264.',
      av1:
        'AV1 benötigt einen aktuellen Browser oder neuere Hardware. Nutze eine aktuelle Version von Chrome oder exportiere die Aufnahme als H.264.',
      other: 'Nutze eine aktuelle Version von Chrome oder Safari oder wandle die Aufnahme zuerst in H.264 um.',
    },
    PIXEL_ASPECT_RATIO:
      'Die Aufnahme gibt ein Pixelseitenverhältnis von {{num}}:{{den}} an. Gespeicherte Pixel bleiben unskaliert, daher kann das dargestellte Seitenverhältnis abweichen.',
    CONTAINER_SIZE_MISMATCH:
      'Der Container gibt {{codedWidth}}×{{codedHeight}} an, der Videodatenstrom tatsächlich aber {{bitstreamWidth}}×{{bitstreamHeight}}. Maßgeblich sind die Abmessungen des Datenstroms.',
    NON_SQUARE_PIXELS:
      'Diese Aufnahme gibt nicht quadratische Pixel an (Anzeige {{displayWidth}}×{{displayHeight}}, Speicherung {{bitstreamWidth}}×{{bitstreamHeight}}). Die gespeicherten Originalpixel bleiben unskaliert erhalten.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'Der Decoder hat ein Bild vor dem Startpunkt der Schnittliste ausgegeben, mit negativem Zeitstempel. Solche Bilder werden entsprechend den Containerregeln nicht angezeigt.',
    NONMONOTONIC_TIMESTAMP:
      'Ein Zeitstempel des Containers ging zurück. Die Verarbeitung wurde in der Anzeigereihenfolge des Decoders fortgesetzt. Keine Beobachtung wurde verworfen.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: Die ctts-Box dieser Videospur hat Version 0, enthält aber negative Zeitversätze für die Bilddarstellung. ISO 14496-12 definiert diese erst ab Version 1. Die Werte werden entsprechend einer verbreiteten QuickTime-/ReplayKit-Konvention mit Vorzeichen interpretiert, nicht als ungewöhnlich große positive Werte.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: Die Datei endet innerhalb ihrer {{box}}-Box. Diese sollte bei Byte {{declaredEnd}} enden, die Datei enthält aber nur {{size}} Bytes. Die Aufnahme wurde möglicherweise nicht korrekt beendet oder die Datei beim Kopieren oder Übertragen abgeschnitten. Nachfolgende Bilder lassen sich nicht dekodieren. Der Scan findet deshalb weniger Bilder als in den Metadaten angegeben und das Ergebnis wird als unvollständig markiert.',
  },
  exports: {
    tilesProgress: 'Original- und Vorschaukacheln exportieren {{n}}',
    zipFinalize: 'ZIP64-Verzeichnis schreiben und Datei speichern',
    projectDone: {
      message:
        'Exportiert: Kacheln in Originalgröße, Offline-Viewer, Abdeckungs- und Qualitätsdaten, Quellbildnachweise und alle Diagnosen.',
    },
    encodingSingle: 'Zeile {{row}} / {{total}} in Originalgröße kodieren',
    canvasDone: {
      message: 'PNG mit {{width}} × {{height}} Pixeln exportiert. Lücken bleiben transparent.',
    },
    encodingSheet: 'Kodierte Teilbilder in Originalgröße: {{count}}',
    sheetsDone: {
      messagePaged:
        'Als Teilbilder in Originalgröße exportiert: {{count}}. Benachbarte Bilder überlappen sich um bis zu {{overlap}} px. Ihre Koordinaten stehen im Manifest.',
      messageOversize:
        'Die Bildfläche überschreitet die kompatible Größe für ein einzelnes Bild. Sie wurde daher ausdrücklich in {{count}} Teilbilder in Originalgröße aufgeteilt. Benachbarte Bilder überlappen sich um bis zu {{overlap}} px. Ihre Koordinaten stehen im Manifest.',
    },
  },
  offline: {
    title: 'Offline-Bildansicht',
    fit: 'Einpassen',
    tip: 'Lokale Kacheln in Originalgröße · ziehen zum Verschieben / scrollen zum Zoomen',
    previewLevel: 'Vorschaustufe {{level}}. Zum Anzeigen der Originalpixel vergrößern',
    nativeTiles: 'Kacheln in Originalgröße werden angezeigt',
    footer:
      'Schachbrettbereiche wurden nicht beobachtet oder enthalten keine Kacheln. Konfidenz ist keine Wahrscheinlichkeit für ein korrektes Ergebnis. Siehe diagnostics.jsonl und observations.jsonl.',
  },
};
