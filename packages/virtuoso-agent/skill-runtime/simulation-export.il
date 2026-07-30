; Cadence-native simulation artifact export for virtuoso-agent.
; These functions run inside the existing managed Virtuoso process.

procedure(vaSimulationExportBoolean(value)
	if(value then "true" else "false")
)

procedure(vaSimulationExportJsonStringList(values)
	let((text separator)
		text = ""
		separator = ""
		foreach(value values
			text = strcat(text separator vaJsonString(value))
			separator = ","
		)
		text
	)
)

procedure(vaSimulationExportEmitError(errorType message resultPath)
	vaSessionWriteResult(resultPath vaErrorEnvelope(errorType message))
)

procedure(vaSimulationExportCreateSchematicNetlist(library cell view)
	let((netlistPath)
		simulator('spectre)
		design(library cell view)
		netlistPath = createNetlist(?recreateAll t ?display nil)
		when(isCallable('ocnCloseSession)
			ocnCloseSession()
		)
		netlistPath
	)
)

procedure(vaSessionExportSchematicNetlist(library cell view resultPath)
	let((captured netlistPath data)
		captured = errset(vaSimulationExportCreateSchematicNetlist(library cell view) t)
		if(captured && car(captured) then
			netlistPath = car(captured)
			data = sprintf(
				nil
				"{\"path\":%s,\"virtuosoVersion\":%s}"
				vaJsonString(netlistPath)
				vaJsonString(getVersion(t))
			)
			vaSessionWriteResult(resultPath vaOkEnvelope(data))
		else
			vaSimulationExportEmitError(
				"SCHEMATIC_NETLIST_EXPORT_FAILED"
				sprintf(nil "Could not create a Spectre netlist for %s/%s/%s." library cell view)
				resultPath
			)
		)
	)
)

procedure(vaSimulationExportWriteSingleOceanScript(path testSession)
	let((filePointer result)
		when(isFile(path)
			deleteFile(path)
		)
		filePointer = asiOpenOceanScript(path)
		unless(filePointer
			error("Could not open OCEAN script %s.\n" path)
		)
		result = asiWriteOceanScript(filePointer testSession)
		asiCloseOceanScript(filePointer)
		unless(result
			error("Could not write OCEAN script %s.\n" path)
		)
		t
	)
)

procedure(vaSimulationExportRestoreEnabledTests(session enabledTests)
	maeEnableTests(?all t ?enable nil ?session session)
	when(enabledTests
		maeEnableTests(?testNames enabledTests ?enable t ?session session)
	)
)

procedure(vaSimulationExportWriteTestSweepOceanScript(path library cell view session testName enabledTests)
	let((result)
		when(isFile(path)
			deleteFile(path)
		)
		unwindProtect(
			progn(
				maeEnableTests(?all t ?enable nil ?session session)
				maeEnableTests(?testNames list(testName) ?enable t ?session session)
				result = axlWriteOceanScriptLCV(path library cell view)
				unless(result
					error("Could not write sweep OCEAN script %s for test %s.\n" path testName)
				)
			)
			vaSimulationExportRestoreEnabledTests(session enabledTests)
		)
		t
	)
)

procedure(vaSimulationExportWriteBoundingBoxJson(filePointer boundingBox)
	unless(boundingBox
		error("Could not resolve a schematic bounding box.\n")
	)
	fprintf(
		filePointer
		"{\"lowerLeft\":{\"x\":%L,\"y\":%L},\"upperRight\":{\"x\":%L,\"y\":%L},\"width\":%L,\"height\":%L}"
		caar(boundingBox)
		cadar(boundingBox)
		caadr(boundingBox)
		cadadr(boundingBox)
		caadr(boundingBox) - caar(boundingBox)
		cadadr(boundingBox) - cadar(boundingBox)
	)
)

procedure(vaSimulationExportWriteSchematicInstances(
	filePointer testName designLibrary designCell designView
)
	let((cellView instances instanceSeparator boundingBox origin testsJson)
		cellView = dbOpenCellViewByType(
			designLibrary designCell designView "schematic" "r"
		)
		unless(cellView
			error(
				"Could not open top-level schematic %s/%s/%s for test %s.\n"
				designLibrary designCell designView testName
			)
		)
		unwindProtect(
			progn(
				instances = cellView~>instances
				testsJson = if(testName == "" then "" else vaJsonString(testName))
				fprintf(
					filePointer
					"{\"design\":{\"library\":%s,\"cell\":%s,\"view\":%s},\"tests\":[%s],\"boundingBox\":"
					vaJsonString(designLibrary)
					vaJsonString(designCell)
					vaJsonString(designView)
					testsJson
				)
				vaSimulationExportWriteBoundingBoxJson(filePointer cellView~>bBox)
				fprintf(
					filePointer
					",\"directInstanceCount\":%d,\"instances\":["
					length(instances)
				)
				instanceSeparator = ""
				foreach(instance instances
					boundingBox = instance~>bBox
					origin = instance~>xy
					unless(origin
						error("Could not resolve origin for top-level instance %s.\n" instance~>name)
					)
					fprintf(
						filePointer
						"%s{\"name\":%s,\"master\":{\"library\":%s,\"cell\":%s,\"view\":%s},\"transform\":{\"origin\":{\"x\":%L,\"y\":%L},\"orientation\":%s,\"magnification\":%L},\"boundingBox\":"
						instanceSeparator
						vaJsonString(instance~>name)
						vaJsonString(instance~>libName)
						vaJsonString(instance~>cellName)
						vaJsonString(instance~>viewName)
						car(origin)
						cadr(origin)
						vaJsonString(instance~>orient)
						instance~>mag
					)
					vaSimulationExportWriteBoundingBoxJson(filePointer boundingBox)
					fprintf(filePointer "}")
					instanceSeparator = ","
				)
				fprintf(filePointer "]}")
			)
			dbClose(cellView)
		)
		t
	)
)

procedure(vaSimulationExportSchematicInstancesToFile(
	library cell view schematicInstancesPath
)
	let((filePointer)
		filePointer = outfile(schematicInstancesPath "w")
		unless(filePointer
			error("Could not open schematic instances artifact %s.\n" schematicInstancesPath)
		)
		unwindProtect(
			progn(
				fprintf(
					filePointer
					"{\"schemaVersion\":1,\"hierarchyPolicy\":\"top-level-only\",\"recursive\":false,\"schematics\":["
				)
				vaSimulationExportWriteSchematicInstances(
					filePointer "" library cell view
				)
				fprintf(filePointer "]}\n")
			)
			close(filePointer)
		)
		t
	)
)

procedure(vaSessionExportSchematicInstances(
	library cell view schematicInstancesPath resultPath
)
	let((captured data)
		captured = errset(
			vaSimulationExportSchematicInstancesToFile(
				library cell view schematicInstancesPath
			)
			t
		)
		if(captured && car(captured) then
			data = sprintf(
				nil
				"{\"path\":%s,\"virtuosoVersion\":%s}"
				vaJsonString(schematicInstancesPath)
				vaJsonString(getVersion(t))
			)
			vaSessionWriteResult(resultPath vaOkEnvelope(data))
		else
			vaSimulationExportEmitError(
				"SCHEMATIC_INSTANCES_EXPORT_FAILED"
				sprintf(
					nil
					"Could not export top-level schematic instances for %s/%s/%s."
					library cell view
				)
				resultPath
			)
		)
	)
)

procedure(vaSimulationExportPrepareMaestro(
	library cell view bundleDir scope requestedTestName outputsMode requestedHistoryName
	schematicInstancesMode requestedOutputTestName
)
	let((
		existingSessions session closeSession tests enabledTests enabledStateCaptured topOceanPath topResult
		includeTop includeTests includeSchematicInstances testItems separator index testName
		exportTest exportSchematic testSession disabledTests disabledTestsJson
		testDir singlePath sweepPath enabled topOceanJson
		designLibrary designCell designView netlistDir simInputFile netlistPath
		includeOutputDefinitions includeOutputResults outputDefinitionsPath outputDefinitionsResult
		setupDatabase historyData historyNames historyEntry outputResultsHistoryName
		outputResultsPath outputResultsResult
		outputDefinitionsJson outputResultsJson outputResultsHistoryJson
		schematicInstancesPath schematicInstancesFile schematicSeparator schematicInstancesJson
	)
		unless(member(scope list("none" "all" "top" "tests" "test"))
			error("Unsupported Maestro export scope: %s.\n" scope)
		)
		unless(member(outputsMode list("none" "definitions" "results" "all"))
			error("Unsupported Maestro output export mode: %s.\n" outputsMode)
		)
		unless(member(schematicInstancesMode list("none" "top-level"))
			error("Unsupported Maestro schematic instances mode: %s.\n" schematicInstancesMode)
		)
		when(scope == "test" && requestedTestName == ""
			error("A test name is required for Maestro export scope test.\n")
		)
		when(
			scope == "none" && requestedTestName != "" &&
			schematicInstancesMode != "top-level"
			error(
				"A test name with Maestro export scope none requires top-level schematic instances.\n"
			)
		)
		when(requestedHistoryName != "" && not(member(outputsMode list("results" "all")))
			error("A history name is only valid when exporting output results.\n")
		)
		when(requestedOutputTestName != "" && outputsMode == "none"
			error("An output test name requires Maestro output export.\n")
		)
		includeTop = member(scope list("all" "top"))
		includeTests = member(scope list("all" "tests" "test"))
		includeOutputDefinitions = member(outputsMode list("definitions" "all"))
		includeOutputResults = member(outputsMode list("results" "all"))
		includeSchematicInstances = schematicInstancesMode == "top-level"
		existingSessions = maeGetSessions()
		session = maeOpenSetup(
			library
			cell
			view
			?mode "r"
			?application "Assembler"
		)
		unless(session
			error("Could not open Maestro setup %s/%s/%s.\n" library cell view)
		)
		closeSession = not(member(session existingSessions))
		unless(maeIsValidMaestroSession(session)
			error("Invalid Maestro setup %s/%s/%s.\n" library cell view)
		)

		unwindProtect(
			progn(
				tests = maeGetSetup(?typeName "tests" ?enabled 'all ?session session)
				when(includeTests
					enabledTests = maeGetSetup(?typeName "tests" ?enabled t ?session session)
					disabledTests = setof(name tests not(member(name enabledTests)))
					enabledStateCaptured = t
				)
				when(
					(scope == "test" || (scope == "none" && requestedTestName != "")) &&
					not(member(requestedTestName tests))
					error("Could not find Maestro test %s.\n" requestedTestName)
				)
				when(
					scope == "test" &&
					not(member(requestedTestName enabledTests))
					error(
						"Maestro test %s is disabled; per-test runnable export requires an enabled test.\n"
						requestedTestName
					)
				)
				when(
					requestedOutputTestName != "" &&
					not(member(requestedOutputTestName tests))
					error("Could not find Maestro output test %s.\n" requestedOutputTestName)
				)
				when(includeOutputDefinitions
					outputDefinitionsPath = strcat(bundleDir "/outputs/definitions/all.csv")
					outputDefinitionsResult = axlOutputsExportToFile(session outputDefinitionsPath)
					unless(outputDefinitionsResult
						error("Could not export Maestro output definitions to %s.\n" outputDefinitionsPath)
					)
				)
				when(includeTop
					topOceanPath = strcat(bundleDir "/maestro/maestro.ocn")
					topResult = axlWriteOceanScriptLCV(topOceanPath library cell view)
					unless(topResult
						error("Could not export top-level Maestro OCEAN script.\n")
					)
				)
				when(includeSchematicInstances
					schematicInstancesPath = strcat(bundleDir "/schematics/all.json")
					schematicInstancesFile = outfile(schematicInstancesPath "w")
					unless(schematicInstancesFile
						error(
							"Could not open schematic instances artifact %s.\n"
							schematicInstancesPath
						)
					)
					fprintf(
						schematicInstancesFile
						"{\"schemaVersion\":1,\"hierarchyPolicy\":\"top-level-only\",\"recursive\":false,\"schematics\":["
					)
					schematicSeparator = ""
				)

				testItems = ""
				separator = ""
				index = 0
				foreach(testName tests
					index = index + 1
					enabled = if(member(testName enabledTests) then t else nil)
					exportTest = includeTests && enabled &&
						(scope != "test" || testName == requestedTestName)
					exportSchematic = includeSchematicInstances &&
						(
							not(member(scope list("test" "none"))) ||
							requestedTestName == "" ||
							testName == requestedTestName
						)
					when(exportTest || exportSchematic
						testSession = maeGetTestSession(testName ?session session)
						unless(testSession
							error("Could not get test session for %s.\n" testName)
						)

						designLibrary = asiGetDesignLibName(testSession)
						designCell = asiGetDesignCellName(testSession)
						designView = asiGetDesignViewName(testSession)
						unless(designLibrary && designCell && designView
							error("Could not resolve the design for test %s.\n" testName)
						)
					)

					when(exportTest
						testDir = sprintf(nil "%s/tests/%03d" bundleDir index)
						unless(isDir(testDir)
							createDir(testDir)
						)
						singlePath = strcat(testDir "/single.ocn")
						sweepPath = strcat(testDir "/sweep.ocn")
						vaSimulationExportWriteSingleOceanScript(singlePath testSession)
						vaSimulationExportWriteTestSweepOceanScript(
							sweepPath library cell view session testName enabledTests
						)
						; asiNetlist only guarantees the lower-level design netlist.  A test
						; which has never run may still lack the composed simulator input
						; returned by asiGetSimInputFileName.  Execute the MAE flowchart
						; through asiComposeSimInput so input.scs is freshly assembled.
						asiExecuteFlowchart(testSession 'asiComposeSimInput)
						netlistDir = asiGetNetlistDir(testSession)
						simInputFile = asiGetSimInputFileName(testSession)
						unless(netlistDir && simInputFile
							error("Could not resolve the generated netlist for test %s.\n" testName)
						)
						netlistPath = strcat(netlistDir "/" simInputFile)
						unless(isFile(netlistPath)
							error("Generated netlist does not exist for test %s: %s.\n" testName netlistPath)
						)

						testItems = strcat(
							testItems
							separator
							sprintf(
								nil
								"{\"index\":%L,\"name\":%s,\"enabled\":%s,\"singleOceanPath\":%s,\"sweepOceanPath\":%s,\"netlistPath\":%s,\"design\":{\"library\":%s,\"cell\":%s,\"view\":%s}}"
								index
								vaJsonString(testName)
								vaSimulationExportBoolean(enabled)
								vaJsonString(singlePath)
								vaJsonString(sweepPath)
								vaJsonString(netlistPath)
								vaJsonString(designLibrary)
								vaJsonString(designCell)
								vaJsonString(designView)
							)
						)
						separator = ","
					)
					when(exportSchematic
						fprintf(schematicInstancesFile "%s" schematicSeparator)
						vaSimulationExportWriteSchematicInstances(
							schematicInstancesFile testName designLibrary designCell designView
						)
						schematicSeparator = ","
					)
				)
				when(includeSchematicInstances
					fprintf(schematicInstancesFile "]}\n")
					close(schematicInstancesFile)
					schematicInstancesFile = nil
				)
				when(includeOutputResults
					setupDatabase = axlGetMainSetupDB(session)
					unless(setupDatabase
						error("Could not get the Maestro setup database.\n")
					)
					if(requestedHistoryName != "" then
						progn(
							historyEntry = axlGetHistoryEntry(setupDatabase requestedHistoryName)
							when(not(historyEntry) || historyEntry == 0
								error("Could not find Maestro history %s.\n" requestedHistoryName)
							)
							outputResultsHistoryName = requestedHistoryName
						)
					else
						progn(
							historyEntry = axlGetCurrentHistory(session)
							when(historyEntry && historyEntry != 0
								outputResultsHistoryName = axlGetHistoryName(historyEntry)
							)
							when(not(outputResultsHistoryName) || outputResultsHistoryName == ""
								historyData = axlGetHistory(setupDatabase)
								historyNames = cadr(historyData)
								unless(historyNames
									error("No saved Maestro history is available.\n")
								)
								outputResultsHistoryName = nth(length(historyNames) - 1 historyNames)
								historyEntry = axlGetHistoryEntry(
									setupDatabase outputResultsHistoryName
								)
								when(not(historyEntry) || historyEntry == 0
									error(
										"Could not resolve the latest Maestro history %s.\n"
										outputResultsHistoryName
									)
								)
							)
						)
					)
					outputResultsPath = strcat(bundleDir "/outputs/results/.all.csv")
					outputResultsResult = maeExportOutputView(
						?session session
						?fileName outputResultsPath
						?view "Detail"
						?historyName outputResultsHistoryName
					)
					unless(outputResultsResult
						error(
							"Could not export the Detail output view for Maestro history %s.\n"
							outputResultsHistoryName
						)
					)
				)
				topOceanJson = if(topOceanPath then vaJsonString(topOceanPath) else "null")
				outputDefinitionsJson = if(
					outputDefinitionsPath then vaJsonString(outputDefinitionsPath) else "null"
				)
				outputResultsJson = if(outputResultsPath then vaJsonString(outputResultsPath) else "null")
				outputResultsHistoryJson = if(
					outputResultsHistoryName then vaJsonString(outputResultsHistoryName) else "null"
				)
				schematicInstancesJson = if(
					schematicInstancesPath then vaJsonString(schematicInstancesPath) else "null"
				)
				disabledTestsJson = vaSimulationExportJsonStringList(disabledTests)
				sprintf(
					nil
					"{\"scope\":%s,\"topOceanPath\":%s,\"virtuosoVersion\":%s,\"tests\":[%s],\"disabledTests\":[%s],\"outputsMode\":%s,\"outputDefinitionsPath\":%s,\"outputResultsPath\":%s,\"outputResultsHistoryName\":%s,\"schematicInstancesMode\":%s,\"schematicInstancesPath\":%s}"
					vaJsonString(scope)
					topOceanJson
					vaJsonString(getVersion(t))
					testItems
					disabledTestsJson
					vaJsonString(outputsMode)
					outputDefinitionsJson
					outputResultsJson
					outputResultsHistoryJson
					vaJsonString(schematicInstancesMode)
					schematicInstancesJson
				)
			)
			progn(
				when(enabledStateCaptured
					vaSimulationExportRestoreEnabledTests(session enabledTests)
				)
				when(schematicInstancesFile
					close(schematicInstancesFile)
				)
				when(closeSession
					maeCloseSession(?session session ?simulation "continue")
				)
			)
		)
	)
)

procedure(vaSessionPrepareMaestroExportV4(library cell view bundleDir scope requestedTestName resultPath)
	let((captured)
		captured = errset(
			vaSimulationExportPrepareMaestro(
				library cell view bundleDir scope requestedTestName "none" "" "none" ""
			)
			t
		)
		if(captured && car(captured) then
			vaSessionWriteResult(resultPath vaOkEnvelope(car(captured)))
		else
			vaSimulationExportEmitError(
				"MAESTRO_EXPORT_PREPARE_FAILED"
				sprintf(nil "Could not export Maestro setup %s/%s/%s." library cell view)
				resultPath
			)
		)
	)
)

procedure(vaSessionPrepareMaestroExportV5(
	library cell view bundleDir scope requestedTestName outputsMode requestedHistoryName resultPath
)
	let((captured)
		captured = errset(
			vaSimulationExportPrepareMaestro(
				library cell view bundleDir scope requestedTestName outputsMode requestedHistoryName "none" ""
			)
			t
		)
		if(captured && car(captured) then
			vaSessionWriteResult(resultPath vaOkEnvelope(car(captured)))
		else
			vaSimulationExportEmitError(
				"MAESTRO_EXPORT_PREPARE_FAILED"
				sprintf(nil "Could not export Maestro setup %s/%s/%s." library cell view)
				resultPath
			)
		)
	)
)

procedure(vaSessionPrepareMaestroExportV6(
	library cell view bundleDir scope requestedTestName outputsMode requestedHistoryName
	schematicInstancesMode resultPath
)
	let((captured)
		captured = errset(
			vaSimulationExportPrepareMaestro(
				library cell view bundleDir scope requestedTestName outputsMode requestedHistoryName
				schematicInstancesMode ""
			)
			t
		)
		if(captured && car(captured) then
			vaSessionWriteResult(resultPath vaOkEnvelope(car(captured)))
		else
			vaSimulationExportEmitError(
				"MAESTRO_EXPORT_PREPARE_FAILED"
				sprintf(nil "Could not export Maestro setup %s/%s/%s." library cell view)
				resultPath
			)
		)
	)
)

procedure(vaSessionPrepareMaestroExportV7(
	library cell view bundleDir scope requestedTestName outputsMode requestedHistoryName
	schematicInstancesMode requestedOutputTestName resultPath
)
	let((captured)
		captured = errset(
			vaSimulationExportPrepareMaestro(
				library cell view bundleDir scope requestedTestName outputsMode requestedHistoryName
				schematicInstancesMode requestedOutputTestName
			)
			t
		)
		if(captured && car(captured) then
			vaSessionWriteResult(resultPath vaOkEnvelope(car(captured)))
		else
			vaSimulationExportEmitError(
				"MAESTRO_EXPORT_PREPARE_FAILED"
				sprintf(nil "Could not export Maestro setup %s/%s/%s." library cell view)
				resultPath
			)
		)
	)
)
