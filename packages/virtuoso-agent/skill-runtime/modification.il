; Controlled incremental modification runtime for virtuoso-agent.
; The TypeScript runtime validates JSON and renders only data lists consumed here.

procedure(vaModificationBoolean(value)
	if(value then "true" else "false")
)

procedure(vaModificationReadTextFile(path)
	let((filePointer line text)
		filePointer = infile(path)
		unless(filePointer
			error("Could not read modification data file %s.\n" path)
		)
		text = ""
		while(gets(line filePointer)
			text = strcat(text line)
		)
		close(filePointer)
		text
	)
)

procedure(vaModificationFindOutput(testSession outputName)
	let((found output)
		foreach(output asiGetOutputList(testSession)
			when(output~>name == outputName
				found = output
			)
		)
		found
	)
)

procedure(vaModificationStateValue(state key defaultValue)
	let((entry)
		entry = assoc(key state)
		if(entry then cadr(entry) else defaultValue)
	)
)

procedure(vaModificationSetState(state key value)
	let((entry)
		entry = assoc(key state)
		if(entry then
			rplaca(cdr(entry) value)
		else
			state = cons(list(key value) state)
		)
		state
	)
)

procedure(vaModificationValidateDevices(
	cellView deviceOperations filePointer
)
	let((
		separator operation id instanceName parameters expectedParameters expectedMaster instance cdfData
		parameterData expected parameter parameterSeparator
	)
		separator = ""
		foreach(operation deviceOperations
			id = nth(0 operation)
			instanceName = nth(1 operation)
			parameters = nth(2 operation)
			expectedParameters = nth(3 operation)
			expectedMaster = nth(4 operation)
			instance = dbFindAnyInstByName(cellView instanceName)
			unless(instance
				error("Modification %s could not find schematic instance %s.\n" id instanceName)
			)
			cdfData = cdfGetInstCDF(instance)
			unless(cdfData
				error("Modification %s could not resolve CDF data for %s.\n" id instanceName)
			)
			when(
				expectedMaster &&
				(
					instance~>libName != nth(0 expectedMaster) ||
					instance~>cellName != nth(1 expectedMaster) ||
					instance~>viewName != nth(2 expectedMaster)
				)
				error(
					"Modification %s expected master %s/%s/%s on %s but found %s/%s/%s.\n"
					id
					nth(0 expectedMaster)
					nth(1 expectedMaster)
					nth(2 expectedMaster)
					instanceName
					instance~>libName
					instance~>cellName
					instance~>viewName
				)
			)
			foreach(expected expectedParameters
				parameterData = get(cdfData concat(car(expected)))
				unless(parameterData
					error(
						"Modification %s could not find expected parameter %s on %s.\n"
						id car(expected) instanceName
					)
				)
			unless(parameterData~>value == cadr(expected)
					error(
						"Modification %s expected %s.%s=%L but found %L.\n"
						id instanceName car(expected) cadr(expected) parameterData~>value
					)
				)
			)
			fprintf(
				filePointer
				"%s{\"id\":%s,\"instance\":%s,\"parameters\":["
				separator
				vaJsonString(id)
				vaJsonString(instanceName)
			)
			parameterSeparator = ""
			foreach(parameter parameters
				parameterData = get(cdfData concat(car(parameter)))
				unless(parameterData
					error(
						"Modification %s could not find CDF parameter %s on %s.\n"
						id car(parameter) instanceName
					)
				)
				fprintf(
					filePointer
					"%s{\"name\":%s,\"before\":%s,\"after\":%s}"
					parameterSeparator
					vaJsonString(car(parameter))
					vaJsonString(parameterData~>value)
					vaJsonString(cadr(parameter))
				)
				parameterSeparator = ","
			)
			fprintf(filePointer "]}")
			separator = ","
		)
	)
)

procedure(vaModificationValidateMaestro(
	session analysisOperations outputOperations filePointer
)
	let((
		tests analysisState outputState separator operation id testName action analysisName
		options expectedOptions currentOptions expected current key enabled testSession outputName
		outputObject expectedExpression currentExpression
	)
		tests = maeGetSetup(?typeName "tests" ?enabled 'all ?session session)
		fprintf(filePointer "],\"analyses\":[")
		separator = ""
		foreach(operation analysisOperations
			id = nth(0 operation)
			testName = nth(1 operation)
			action = nth(2 operation)
			analysisName = nth(3 operation)
			options = nth(4 operation)
			expectedOptions = nth(5 operation)
			unless(member(testName tests)
				error("Modification %s could not find Maestro test %s.\n" id testName)
			)
			key = strcat(testName "::" analysisName)
			enabled = vaModificationStateValue(
				analysisState
				key
				member(analysisName maeGetEnabledAnalysis(testName ?session session))
			)
			when(action == "add" && enabled
				error(
					"Modification %s cannot add already-enabled analysis %s in test %s.\n"
					id analysisName testName
				)
			)
			when(action == "delete" && not(enabled)
				error(
					"Modification %s cannot delete disabled or missing analysis %s in test %s.\n"
					id analysisName testName
				)
			)
			when(expectedOptions
				currentOptions = maeGetAnalysis(
					testName analysisName ?includeEmpty nil ?session session
				)
				foreach(expected expectedOptions
					current = assoc(car(expected) currentOptions)
					unless(current && cadr(current) == cadr(expected)
						error(
							"Modification %s expected analysis %s option %s=%L but found %L.\n"
							id analysisName car(expected) cadr(expected)
							if(current then cadr(current) else nil)
						)
					)
				)
			)
			fprintf(
				filePointer
				"%s{\"id\":%s,\"testName\":%s,\"analysis\":%s,\"operation\":%s,\"beforeEnabled\":%s,\"afterEnabled\":%s}"
				separator
				vaJsonString(id)
				vaJsonString(testName)
				vaJsonString(analysisName)
				vaJsonString(action)
				vaModificationBoolean(enabled)
				vaModificationBoolean(action == "add")
			)
			analysisState = vaModificationSetState(
				analysisState key action == "add"
			)
			separator = ","
		)

		fprintf(filePointer "],\"outputs\":[")
		separator = ""
		foreach(operation outputOperations
			id = nth(0 operation)
			testName = nth(1 operation)
			action = nth(2 operation)
			outputName = nth(3 operation)
			expectedExpression = nth(9 operation)
			unless(member(testName tests)
				error("Modification %s could not find Maestro test %s.\n" id testName)
			)
			key = strcat(testName "::" outputName)
			testSession = maeGetTestSession(testName ?session session)
			unless(testSession
				error("Modification %s could not get test session %s.\n" id testName)
			)
			outputObject = vaModificationFindOutput(testSession outputName)
			enabled = vaModificationStateValue(outputState key if(outputObject then t else nil))
			when(action == "add" && enabled
				error(
					"Modification %s cannot add existing output %s in test %s.\n"
					id outputName testName
				)
			)
			when(action == "delete" && not(enabled)
				error(
					"Modification %s cannot delete missing output %s in test %s.\n"
					id outputName testName
				)
			)
			when(action == "delete" && expectedExpression != ""
				currentExpression = sprintf(nil "%L" outputObject~>expression)
				unless(currentExpression == expectedExpression
					error(
						"Modification %s expected output %s expression %s but found %s.\n"
						id outputName expectedExpression currentExpression
					)
				)
			)
			fprintf(
				filePointer
				"%s{\"id\":%s,\"testName\":%s,\"output\":%s,\"operation\":%s,\"beforeExists\":%s,\"afterExists\":%s}"
				separator
				vaJsonString(id)
				vaJsonString(testName)
				vaJsonString(outputName)
				vaJsonString(action)
				vaModificationBoolean(enabled)
				vaModificationBoolean(action == "add")
			)
			outputState = vaModificationSetState(outputState key action == "add")
			separator = ","
		)
	)
)

procedure(vaModificationApplyDevices(cellView deviceOperations)
	let((operation instance cdfData parameterData callback callbackResult)
		foreach(operation deviceOperations
			instance = dbFindAnyInstByName(cellView nth(1 operation))
			cdfData = cdfGetInstCDF(instance)
			foreach(parameter nth(2 operation)
				parameterData = get(cdfData concat(car(parameter)))
				parameterData~>value = cadr(parameter)
				callback = parameterData~>callback
				when(callback && callback != ""
					cdfgData = cdfData
					callbackResult = errsetstring(callback t)
					unless(callbackResult
						error(
							"CDF callback failed after setting %s.%s.\n"
							instance~>name car(parameter)
						)
					)
				)
			)
		)
	)
)

procedure(vaModificationApplyMaestro(session analysisOperations outputOperations)
	let((operation testName action analysisName options result outputName outputType expression signalName plot save)
		foreach(operation analysisOperations
			testName = nth(1 operation)
			action = nth(2 operation)
			analysisName = nth(3 operation)
			options = nth(4 operation)
			result = maeSetAnalysis(
				testName
				analysisName
				?enable action == "add"
				?options options
				?session session
			)
			unless(result
				error(
					"Could not %s analysis %s in test %s.\n"
					action analysisName testName
				)
			)
		)
		foreach(operation outputOperations
			testName = nth(1 operation)
			action = nth(2 operation)
			outputName = nth(3 operation)
			if(action == "add" then
				progn(
					outputType = nth(4 operation)
					expression = nth(5 operation)
					signalName = nth(6 operation)
					plot = nth(7 operation)
					save = nth(8 operation)
					result = maeAddOutput(
						outputName
						testName
						?outputType outputType
						?signalName signalName
						?expr expression
						?plot plot
						?save save
						?session session
					)
				)
			else
				result = maeDeleteOutput(outputName testName ?session session)
			)
			unless(result
				error(
					"Could not %s output %s in test %s.\n"
					action outputName testName
				)
			)
		)
	)
)

procedure(vaModificationWriteVerification(
	filePointer cellView session deviceOperations analysisOperations outputOperations
)
	let((
		separator operation instance cdfData parameterData parameterSeparator
		testName analysisName outputName testSession
	)
		fprintf(filePointer ",\"verification\":{\"deviceParameters\":[")
		separator = ""
		foreach(operation deviceOperations
			instance = dbFindAnyInstByName(cellView nth(1 operation))
			cdfData = cdfGetInstCDF(instance)
			fprintf(
				filePointer
				"%s{\"id\":%s,\"instance\":%s,\"parameters\":["
				separator
				vaJsonString(nth(0 operation))
				vaJsonString(nth(1 operation))
			)
			parameterSeparator = ""
			foreach(parameter nth(2 operation)
				parameterData = get(cdfData concat(car(parameter)))
				fprintf(
					filePointer
					"%s{\"name\":%s,\"actual\":%s}"
					parameterSeparator
					vaJsonString(car(parameter))
					vaJsonString(parameterData~>value)
				)
				parameterSeparator = ","
			)
			fprintf(filePointer "]}")
			separator = ","
		)
		fprintf(filePointer "],\"analyses\":[")
		separator = ""
		foreach(operation analysisOperations
			testName = nth(1 operation)
			analysisName = nth(3 operation)
			fprintf(
				filePointer
				"%s{\"id\":%s,\"enabled\":%s}"
				separator
				vaJsonString(nth(0 operation))
				vaModificationBoolean(
					member(analysisName maeGetEnabledAnalysis(testName ?session session))
				)
			)
			separator = ","
		)
		fprintf(filePointer "],\"outputs\":[")
		separator = ""
		foreach(operation outputOperations
			testName = nth(1 operation)
			outputName = nth(3 operation)
			testSession = maeGetTestSession(testName ?session session)
			fprintf(
				filePointer
				"%s{\"id\":%s,\"exists\":%s}"
				separator
				vaJsonString(nth(0 operation))
				vaModificationBoolean(
					vaModificationFindOutput(testSession outputName)
				)
			)
			separator = ","
		)
		fprintf(filePointer "]}")
	)
)

procedure(vaModificationExecute(
	schematicLibrary schematicCell schematicView
	maestroLibrary maestroCell maestroView
	deviceOperations analysisOperations outputOperations runSchematicCheck applyChanges resultPath
)
	let((
		captured dataFile dataPath cellView session existingSessions closeSession
		schematicSaved schematicCheck maestroSaved schematicUi maestroUi data schematicWindow
	)
		dataPath = strcat(resultPath ".data")
		captured = errset(
			progn(
				dataFile = outfile(dataPath "w")
				unless(dataFile
					error("Could not create modification result data %s.\n" dataPath)
				)
				fprintf(
					dataFile
					"{\"apply\":%s,\"deviceParameters\":["
					vaModificationBoolean(applyChanges)
				)

				when(deviceOperations
					cellView = dbOpenCellViewByType(
						schematicLibrary schematicCell schematicView "schematic"
						if(applyChanges then "a" else "r")
					)
					unless(cellView
						error(
							"Could not open schematic %s/%s/%s.\n"
							schematicLibrary schematicCell schematicView
						)
					)
					vaModificationValidateDevices(
						cellView deviceOperations dataFile
					)
				)

				if(analysisOperations || outputOperations then
					progn(
						existingSessions = maeGetSessions()
						session = maeOpenSetup(
							maestroLibrary
							maestroCell
							maestroView
							?mode if(applyChanges then "a" else "r")
							?application "Assembler"
						)
						unless(session && maeIsValidMaestroSession(session)
							error(
								"Could not open Maestro setup %s/%s/%s.\n"
								maestroLibrary maestroCell maestroView
							)
						)
						closeSession = not(member(session existingSessions))
						vaModificationValidateMaestro(
							session analysisOperations outputOperations dataFile
						)
					)
				else
					fprintf(dataFile "],\"analyses\":[],\"outputs\":[")
				)

				when(applyChanges
					when(deviceOperations
						vaModificationApplyDevices(cellView deviceOperations)
					)
					when(session
						vaModificationApplyMaestro(
							session analysisOperations outputOperations
						)
					)
					when(deviceOperations
						if(runSchematicCheck then
							schematicCheck = schCheck(cellView)
						else
							schematicCheck = "skipped"
						)
						schematicSaved = dbSave(cellView)
						unless(schematicSaved
							error("Could not save modified schematic.\n")
						)
						schematicWindow = geGetCellViewWindow(cellView)
						if(schematicWindow then
							progn(
								geRefreshWindow(schematicWindow)
								schematicUi = "refreshed"
							)
						else
							schematicUi = "not-open"
						)
					)
					when(session
						maestroSaved = maeSaveSetup(?session session)
						unless(maestroSaved
							error("Could not save modified Maestro setup.\n")
						)
						maestroUi = if(member(session existingSessions) then "refreshed" else "not-open")
					)
				)
				fprintf(
					dataFile
					"],\"schematic\":{\"saved\":%s,\"check\":%s,\"uiStatus\":%s},\"maestro\":{\"saved\":%s,\"uiStatus\":%s}"
					vaModificationBoolean(schematicSaved)
					vaJsonString(sprintf(nil "%L" schematicCheck))
					vaJsonString(if(schematicUi then schematicUi else "not-applicable"))
					vaModificationBoolean(maestroSaved)
					vaJsonString(if(maestroUi then maestroUi else "not-applicable"))
				)
				if(applyChanges then
					vaModificationWriteVerification(
						dataFile cellView session deviceOperations analysisOperations outputOperations
					)
				else
					fprintf(dataFile ",\"verification\":null")
				)
				fprintf(dataFile "}")
				close(dataFile)
				dataFile = nil
				data = vaModificationReadTextFile(dataPath)
				vaSessionWriteResult(resultPath vaOkEnvelope(data))
				t
			)
			t
		)
		when(dataFile
			close(dataFile)
		)
		when(cellView
			dbClose(cellView)
		)
		when(session && closeSession
			maeCloseSession(?session session ?simulation "continue")
		)
		when(isFile(dataPath)
			deleteFile(dataPath)
		)
		unless(captured && car(captured)
			vaSessionWriteResult(
				resultPath
				vaErrorEnvelope(
					"MODIFICATION_FAILED"
					"Virtuoso could not validate or apply the modification plan."
				)
			)
		)
	)
)
