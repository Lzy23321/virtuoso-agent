; Read-only, structured Maestro setup inspection for virtuoso-agent.
; Loaded only by the maestro inspect workflow.

procedure(vaMaestroJsonEscape(value)
    let((text escaped index char)
        text = if(value then
            if(stringp(value) then sprintf(nil "%s" value) else sprintf(nil "%L" value))
        else
            ""
        )
        escaped = ""
        for(index 1 strlen(text)
            char = substring(text index 1)
            escaped = strcat(
                escaped
                cond(
                    ((char == "\\") "\\\\")
                    ((char == "\"") "\\\"")
                    ((char == "\n") "\\n")
                    ((char == "\r") "\\r")
                    ((char == "\t") "\\t")
                    (t char)
                )
            )
        )
        escaped
    )
)

procedure(vaMaestroJsonString(value)
    strcat("\"" vaMaestroJsonEscape(value) "\"")
)

procedure(vaMaestroJsonList(value)
    let((items separator)
        items = ""
        separator = ""
        foreach(item value
            items = strcat(items separator vaMaestroJsonValue(item))
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroJsonValue(value)
    cond(
        ((null value) "null")
        ((eq value t) "true")
        ((stringp value) vaMaestroJsonString(value))
        ((numberp value) sprintf(nil "%L" value))
        ((listp value) vaMaestroJsonList(value))
        (t vaMaestroJsonString(sprintf(nil "%L" value)))
    )
)

procedure(vaMaestroJsonBoolean(value)
    if(value then "true" else "false")
)

procedure(vaMaestroCount(items)
    let((count)
        count = 0
        foreach(item items count = count + 1)
        count
    )
)

procedure(vaMaestroMeaningful(value)
    cond(
        ((null value) nil)
        ((stringp value) strlen(value) > 0)
        ((listp value) vaMaestroCount(value) > 0)
        (t t)
    )
)

procedure(vaMaestroStripWrappingQuotes(value)
    if(
        stringp(value) &&
        strlen(value) >= 2 &&
        substring(value 1 1) == "\"" &&
        substring(value strlen(value) 1) == "\""
    then
        substring(value 2 strlen(value) - 2)
    else
        value
    )
)

procedure(vaMaestroEndsWith(text suffix)
    stringp(text) &&
    stringp(suffix) &&
    strlen(text) >= strlen(suffix) &&
    substring(text strlen(text) - strlen(suffix) + 1 strlen(suffix)) == suffix
)

procedure(vaMaestroSettingsJson(session testName analysisName)
    let((items separator)
        items = ""
        separator = ""
        foreach(optionPair
            maeGetAnalysis(
                testName
                analysisName
                ?includeEmpty t
                ?session session
            )
            when(vaMaestroMeaningful(cadr(optionPair))
                items = strcat(
                    items
                    separator
                    vaMaestroJsonString(car(optionPair))
                    ":"
                    vaMaestroJsonValue(cadr(optionPair))
                )
                separator = ","
            )
        )
        strcat("{" items "}")
    )
)

procedure(vaMaestroAnalysesJson(session testName)
    let((items separator analyses)
        items = ""
        separator = ""
        analyses = maeGetEnabledAnalysis(testName ?session session)
        foreach(analysisName analyses
            items = strcat(
                items
                separator
                sprintf(
                    nil
                    "{\"type\":%s,\"enabled\":true,\"effectiveSettings\":%s}"
                    vaMaestroJsonString(analysisName)
                    vaMaestroSettingsJson(session testName analysisName)
                )
            )
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroDesignVariablesJson(testSession)
    let((items separator)
        items = ""
        separator = ""
        when(testSession
            foreach(variablePair asiGetDesignVarList(testSession)
                items = strcat(
                    items
                    separator
                    sprintf(
                        nil
                        "{\"name\":%s,\"value\":%s}"
                        vaMaestroJsonString(car(variablePair))
                        vaMaestroJsonValue(cadr(variablePair))
                    )
                )
                separator = ","
            )
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroSpecJson(spec)
    let((kind operator target display firstText secondText)
        if(spec then
            kind = car(spec)
            operator = cond(
                (equal(kind "gt") ">")
                (equal(kind "lt") "<")
                (equal(kind "max") "<=")
                (equal(kind "min") ">=")
                (equal(kind "range") "range")
                (t sprintf(nil "%L" kind))
            )
            target = if(vaMaestroCount(cdr(spec)) == 1 then cadr(spec) else cdr(spec))
			firstText = if(stringp(cadr(spec)) then cadr(spec) else sprintf(nil "%L" cadr(spec)))
			secondText = if(stringp(caddr(spec)) then caddr(spec) else sprintf(nil "%L" caddr(spec)))
            display = if(equal(kind "range") then
                sprintf(nil "%s .. %s" firstText secondText)
            else
                sprintf(nil "%s %s" operator firstText)
            )
            sprintf(
                nil
                "{\"operator\":%s,\"target\":%s,\"display\":%s,\"native\":%s}"
                vaMaestroJsonString(operator)
                vaMaestroJsonValue(target)
                vaMaestroJsonString(display)
                vaMaestroJsonValue(spec)
            )
        else
            "null"
        )
    )
)

procedure(vaMaestroOutputHasContent(output)
    or(
        output->name
        output->signal
        output->expression
        output->scriptFile
    )
)

procedure(vaMaestroOutputType(output)
    cond(
        (output->type2 sprintf(nil "%L" output->type2))
        (output->scriptFile "script")
        (output->expression "expr")
        (output->signal "signal")
        (t "unknown")
    )
)

procedure(vaMaestroOutputDetails(output)
    cond(
        (output->scriptFile output->scriptFile)
        (output->expression sprintf(nil "%L" output->expression))
        (output->signal output->signal)
        (t nil)
    )
)

procedure(vaMaestroOutputsJson(session mainSDB testName)
    let((items separator outputs spec details outputType plotTarget outputName)
        items = ""
        separator = ""
        outputs = maeGetTestOutputs(testName ?session session)
        foreach(output outputs
            when(vaMaestroOutputHasContent(output)
                outputName = if(output->name then output->name else output->signal)
                spec = if(mainSDB && stringp(outputName) then axlGetSpecData(mainSDB outputName testName) else nil)
                outputType = vaMaestroOutputType(output)
                details = vaMaestroOutputDetails(output)
                plotTarget = if(output->graphType then output->graphType else output->waveSpec)
                items = strcat(
                    items
                    separator
                    sprintf(
                        nil
                        "{\"name\":%s,\"type\":%s,\"details\":%s,\"plot\":%s,\"plotTarget\":%s,\"save\":%s,\"spec\":%s}"
                        vaMaestroJsonValue(outputName)
                        vaMaestroJsonString(outputType)
                        vaMaestroJsonValue(details)
                        vaMaestroJsonBoolean(output->plot)
                        vaMaestroJsonValue(plotTarget)
                        vaMaestroJsonBoolean(output->save)
                        vaMaestroSpecJson(spec)
                    )
                )
                separator = ","
            )
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroModelEntryEnabled(entry)
    let((first)
        first = car(entry)
        if(stringp(first) then
            if(strlen(first) > 0 then substring(first 1 1) != "#" else nil)
        else
            nil
        )
    )
)

procedure(vaMaestroActiveModelsJson(modelFiles)
    let((items separator path section)
        items = ""
        separator = ""
        foreach(entry modelFiles
            when(vaMaestroModelEntryEnabled(entry)
                path = car(entry)
                section = vaMaestroStripWrappingQuotes(cadr(entry))
                items = strcat(
                    items
                    separator
                    sprintf(
                        nil
                        "{\"configuredPath\":%s,\"path\":%s,\"available\":%s,\"section\":%s}"
                        vaMaestroJsonValue(path)
                        vaMaestroJsonValue(if(isFile(path) then path else nil))
                        vaMaestroJsonBoolean(isFile(path))
                        vaMaestroJsonValue(section)
                    )
                )
                separator = ","
            )
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroProcessCornersJson(modelFiles)
    let((items separator)
        items = ""
        separator = ""
        foreach(entry modelFiles
            when(vaMaestroModelEntryEnabled(entry)
                items = strcat(items separator vaMaestroJsonValue(vaMaestroStripWrappingQuotes(cadr(entry))))
                separator = ","
            )
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroResolveModelPath(configuredPath modelName fallbackModelFiles)
    let((resolved candidate)
        resolved = if(configuredPath && isFile(configuredPath) then configuredPath else nil)
        unless(resolved
            foreach(entry fallbackModelFiles
                candidate = car(entry)
                when(
                    !resolved &&
                    vaMaestroModelEntryEnabled(entry) &&
                    isFile(candidate) &&
                    vaMaestroEndsWith(candidate modelName)
                    resolved = candidate
                )
            )
        )
        resolved
    )
)

procedure(vaMaestroCornerModelsJson(mainSDB cornerName fallbackModelFiles)
    let((items separator cornerHandle models modelHandle configuredPath resolvedPath section)
        items = ""
        separator = ""
        cornerHandle = if(mainSDB then axlGetCorner(mainSDB cornerName) else nil)
        models = if(cornerHandle && cornerHandle != 0 then axlGetModels(cornerHandle) else nil)
        if(models && cadr(models) then
            foreach(modelName cadr(models)
                modelHandle = axlGetModel(cornerHandle modelName)
                when(modelHandle && modelHandle != 0
                    configuredPath = axlGetModelFile(modelHandle)
                    resolvedPath = vaMaestroResolveModelPath(configuredPath modelName fallbackModelFiles)
                    section = vaMaestroStripWrappingQuotes(axlGetModelSection(modelHandle))
                    items = strcat(
                        items
                        separator
                        sprintf(
                            nil
                            "{\"configuredPath\":%s,\"path\":%s,\"available\":%s,\"section\":%s}"
                            vaMaestroJsonValue(configuredPath)
                            vaMaestroJsonValue(resolvedPath)
                            vaMaestroJsonBoolean(resolvedPath)
                            vaMaestroJsonValue(section)
                        )
                    )
                    separator = ","
                )
            )
            strcat("[" items "]")
        else
            vaMaestroActiveModelsJson(fallbackModelFiles)
        )
    )
)

procedure(vaMaestroCornerSectionsJson(mainSDB cornerName fallbackModelFiles)
    let((items separator cornerHandle models modelHandle section)
        items = ""
        separator = ""
        cornerHandle = if(mainSDB then axlGetCorner(mainSDB cornerName) else nil)
        models = if(cornerHandle && cornerHandle != 0 then axlGetModels(cornerHandle) else nil)
        if(models && cadr(models) then
            foreach(modelName cadr(models)
                modelHandle = axlGetModel(cornerHandle modelName)
                section = if(modelHandle && modelHandle != 0 then vaMaestroStripWrappingQuotes(axlGetModelSection(modelHandle)) else nil)
                when(section
                    items = strcat(items separator vaMaestroJsonValue(section))
                    separator = ","
                )
            )
            strcat("[" items "]")
        else
            vaMaestroProcessCornersJson(fallbackModelFiles)
        )
    )
)

procedure(vaMaestroCornerVariablesJson(mainSDB cornerName)
    let((items separator cornerHandle variables varHandle)
        items = ""
        separator = ""
        cornerHandle = if(mainSDB then axlGetCorner(mainSDB cornerName) else nil)
        when(cornerHandle && cornerHandle != 0
            variables = axlGetVars(cornerHandle)
            when(variables
                foreach(variableName cadr(variables)
                    varHandle = axlGetVar(cornerHandle variableName)
                    items = strcat(
                        items
                        separator
                        vaMaestroJsonString(variableName)
                        ":"
                        vaMaestroJsonValue(if(varHandle then axlGetVarValue(varHandle) else nil))
                    )
                    separator = ","
                )
            )
        )
        strcat("{" items "}")
    )
)

procedure(vaMaestroCornerTemperature(mainSDB cornerName defaultTemperature)
    let((cornerHandle variableHandle value)
        value = defaultTemperature
        cornerHandle = if(mainSDB then axlGetCorner(mainSDB cornerName) else nil)
        when(cornerHandle && cornerHandle != 0
            variableHandle = axlGetVar(cornerHandle "temperature")
            when(variableHandle value = axlGetVarValue(variableHandle))
        )
        value
    )
)

procedure(vaMaestroCornersJson(session mainSDB testName corners)
    let((items separator modelFiles temperature cornerHandle disabledTests includeCorner)
        items = ""
        separator = ""
        modelFiles = maeGetEnvOption(testName ?option "modelFiles" ?session session)
        temperature = maeGetSimOption(testName ?option "temp" ?session session)
        foreach(cornerName corners
            cornerHandle = if(mainSDB then axlGetCorner(mainSDB cornerName) else nil)
            disabledTests = if(cornerHandle && cornerHandle != 0 then cadr(axlGetCornerDisabledTests(cornerHandle)) else nil)
            includeCorner = !member(testName disabledTests)
            when(includeCorner
                items = strcat(
                    items
                    separator
                    sprintf(
                        nil
                        "{\"name\":%s,\"temperature\":%s,\"processCorner\":%s,\"modelFiles\":%s,\"variables\":%s}"
                        vaMaestroJsonString(cornerName)
                        vaMaestroJsonValue(vaMaestroCornerTemperature(mainSDB cornerName temperature))
                        vaMaestroCornerSectionsJson(mainSDB cornerName modelFiles)
                        vaMaestroCornerModelsJson(mainSDB cornerName modelFiles)
                        vaMaestroCornerVariablesJson(mainSDB cornerName)
                    )
                )
                separator = ","
            )
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroFallbackNetlistDirectory(library cell view testName testSession)
    let((home userName simulator designLibrary designCell designView)
        home = getShellEnvVar("HOME")
        userName = getShellEnvVar("USER")
        simulator = asiGetAnalogSimulator(testSession)
        designLibrary = asiGetDesignLibName(testSession)
        designCell = asiGetDesignCellName(testSession)
        designView = asiGetDesignViewName(testSession)
        strcat(
            home
            "/simulation/" library "/" cell "/" view "/results/" view
            "/.tmpADEDir_" userName "/" testName "/"
            designLibrary "_" designCell "_" designView "_" simulator
            "/netlist"
        )
    )
)

procedure(vaMaestroNetlistJson(library cell view testName testSession)
    let((apiDirectory directory discovery available)
        apiDirectory = asiGetResultsNetlistDir(testSession)
        directory = if(apiDirectory then
            apiDirectory
        else
            vaMaestroFallbackNetlistDirectory(library cell view testName testSession)
        )
        discovery = if(apiDirectory then "api" else "filesystem")
        available = if(directory then isDir(directory) else nil)
        sprintf(
            nil
            "{\"directory\":%s,\"discovery\":%s,\"available\":%s}"
            vaMaestroJsonValue(if(available then directory else nil))
            vaMaestroJsonString(discovery)
            vaMaestroJsonBoolean(available)
        )
    )
)

procedure(vaMaestroTestsJson(session mainSDB library cell view tests enabledTests corners)
    let((items separator testSession)
        items = ""
        separator = ""
        foreach(testName tests
            testSession = maeGetTestSession(testName ?session session)
            items = strcat(
                items
                separator
                sprintf(
                    nil
                    "{\"name\":%s,\"enabled\":%s,\"design\":{\"library\":%s,\"cell\":%s,\"view\":%s},\"simulator\":%s,\"analyses\":%s,\"designVariables\":%s,\"corners\":%s,\"outputsSetup\":%s,\"netlist\":%s}"
                    vaMaestroJsonString(testName)
                    vaMaestroJsonBoolean(member(testName enabledTests))
                    vaMaestroJsonValue(if(testSession then asiGetDesignLibName(testSession) else nil))
                    vaMaestroJsonValue(if(testSession then asiGetDesignCellName(testSession) else nil))
                    vaMaestroJsonValue(if(testSession then asiGetDesignViewName(testSession) else nil))
                    vaMaestroJsonValue(if(testSession then asiGetAnalogSimulator(testSession) else nil))
                    vaMaestroAnalysesJson(session testName)
                    vaMaestroDesignVariablesJson(testSession)
                    vaMaestroCornersJson(session mainSDB testName corners)
                    vaMaestroOutputsJson(session mainSDB testName)
                    vaMaestroNetlistJson(library cell view testName testSession)
                )
            )
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroGlobalVariablesJson(session variables enabledVariables)
    let((items separator)
        items = ""
        separator = ""
        foreach(variableName variables
            items = strcat(
                items
                separator
                sprintf(
                    nil
                    "{\"name\":%s,\"enabled\":%s,\"value\":%s,\"resolvedValue\":%s}"
                    vaMaestroJsonString(variableName)
                    vaMaestroJsonBoolean(member(variableName enabledVariables))
                    vaMaestroJsonValue(maeGetVar(variableName ?typeName "test" ?typeValue "Global" ?session session))
                    vaMaestroJsonValue(maeGetVar(variableName ?typeName "test" ?typeValue "Global" ?resolved t ?session session))
                )
            )
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroParametersJson(session parameters enabledParameters)
    let((items separator)
        items = ""
        separator = ""
        foreach(parameterName parameters
            items = strcat(
                items
                separator
                sprintf(
                    nil
                    "{\"path\":%s,\"enabled\":%s,\"value\":%s}"
                    vaMaestroJsonString(parameterName)
                    vaMaestroJsonBoolean(member(parameterName enabledParameters))
                    vaMaestroJsonValue(maeGetParameter(parameterName ?typeName "test" ?session session))
                )
            )
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaMaestroCountOutputs(session testName)
    let((count)
        count = 0
        foreach(output maeGetTestOutputs(testName ?session session)
            when(vaMaestroOutputHasContent(output)
                count = count + 1
            )
        )
        count
    )
)

procedure(vaMaestroCountParameterValues(session parameters)
    let((count value)
        count = 0
        foreach(parameterName parameters
            value = maeGetParameter(parameterName ?typeName "test" ?session session)
            when(vaMaestroMeaningful(value)
                count = count + 1
            )
        )
        count
    )
)

procedure(vaMaestroCountTestEntries(session tests kind)
    let((count testSession values)
        count = 0
        foreach(testName tests
            testSession = maeGetTestSession(testName ?session session)
            values = cond(
                (equal(kind "variables") if(testSession then asiGetDesignVarList(testSession) else nil))
                (equal(kind "analyses") maeGetEnabledAnalysis(testName ?session session))
                (equal(kind "outputs") nil)
                (t nil)
            )
            count = count + if(equal(kind "outputs") then vaMaestroCountOutputs(session testName) else vaMaestroCount(values))
        )
        count
    )
)

procedure(vaMaestroUniqueTestVariableCount(session tests)
    let((names testSession)
        names = nil
        foreach(testName tests
            testSession = maeGetTestSession(testName ?session session)
            when(testSession
                foreach(variablePair asiGetDesignVarList(testSession)
                    unless(member(car(variablePair) names)
                        names = cons(car(variablePair) names)
                    )
                )
            )
        )
        vaMaestroCount(names)
    )
)

procedure(vaMaestroStoragePath(library cell view)
    let((viewObject)
        viewObject = ddGetObj(library cell view)
        if(viewObject then
            if(viewObject~>readPath then viewObject~>readPath else viewObject~>writePath)
        else
            nil
        )
    )
)

procedure(vaMaestroEmitOk(manifest resultPath)
    if(resultPath then
        vaSessionWriteResult(resultPath vaOkEnvelope(manifest))
    else
        vaPrintOk(manifest)
    )
)

procedure(vaMaestroEmitError(errorType message resultPath)
    if(resultPath then
        vaSessionWriteResult(resultPath vaErrorEnvelope(errorType message))
    else
        vaPrintError(errorType message)
    )
)

procedure(vaInspectMaestroInternal(library cell view resultPath)
    let((
        session mainSDB tests enabledTests variables enabledVariables
        parameters enabledParameters corners testJson globalVariableJson
        parameterJson storagePath closeResult manifest singleTest modified
        runMode setupLibrary testVariableEntries uniqueTestVariables
        analysisEntries outputEntries parameterValueCount
    )
        session = maeOpenSetup(library cell view ?mode "r")
        cond(
            ((null session)
                vaMaestroEmitError(
                    "MAESTRO_OPEN_FAILED"
                    sprintf(nil "Could not open maestro setup %s/%s/%s." library cell view)
                    resultPath
                )
            )
            ((null maeIsValidMaestroSession(session))
                maeCloseSession(?session session ?simulation "continue")
                vaMaestroEmitError(
                    "MAESTRO_INVALID_SESSION"
                    sprintf(nil "Invalid Maestro session for %s/%s/%s." library cell view)
                    resultPath
                )
            )
            (t
                mainSDB = axlGetMainSetupDB(session)
                tests = maeGetSetup(?typeName "tests" ?enabled 'all ?session session)
                enabledTests = maeGetSetup(?typeName "tests" ?enabled t ?session session)
                variables = maeGetSetup(?typeName "variables" ?enabled 'all ?session session)
                enabledVariables = maeGetSetup(?typeName "variables" ?enabled t ?session session)
                parameters = maeGetSetup(?typeName "parameters" ?enabled 'all ?session session)
                enabledParameters = maeGetSetup(?typeName "parameters" ?enabled t ?session session)
                corners = maeGetSetup(?typeName "corners" ?enabled t ?session session)
                singleTest = maeIsSingleTest(library cell view)
                modified = maeIsSetupModified(?session session)
                runMode = maeGetCurrentRunMode(?session session)
                setupLibrary = maeGetSetupLibrary(?session session)
                testVariableEntries = vaMaestroCountTestEntries(session tests "variables")
                uniqueTestVariables = vaMaestroUniqueTestVariableCount(session tests)
                analysisEntries = vaMaestroCountTestEntries(session tests "analyses")
                outputEntries = vaMaestroCountTestEntries(session tests "outputs")
                parameterValueCount = vaMaestroCountParameterValues(session parameters)

                testJson = vaMaestroTestsJson(session mainSDB library cell view tests enabledTests corners)
                globalVariableJson = vaMaestroGlobalVariablesJson(session variables enabledVariables)
                parameterJson = vaMaestroParametersJson(session parameters enabledParameters)
                storagePath = vaMaestroStoragePath(library cell view)

                closeResult = maeCloseSession(?session session ?simulation "continue")

                manifest = sprintf(
                    nil
                    "{\"schemaVersion\":\"0.1-prototype\",\"kind\":\"maestro-inspect\",\"generatedAt\":%s,\"target\":{\"library\":%s,\"cell\":%s,\"view\":%s},\"source\":{\"openMode\":\"r\",\"virtuosoVersion\":%s},\"session\":{\"name\":%s,\"valid\":true,\"singleTest\":%s,\"modified\":%s,\"runMode\":%s,\"setupLibrary\":%s,\"closedAfterInspect\":%s},\"storage\":{\"path\":%s},\"summary\":{\"tests\":%L,\"enabledTests\":%L,\"globalVariables\":%L,\"testVariableEntries\":%L,\"uniqueTestVariables\":%L,\"parameters\":{\"total\":%L,\"enabled\":%L,\"disabled\":%L,\"withValue\":%L},\"corners\":%L,\"analysisEntries\":%L,\"outputs\":%L},\"maestro\":{\"globalVariables\":%s,\"parameters\":%s},\"tests\":%s,\"warnings\":[]}"
                    vaMaestroJsonString(getCurrentTime())
                    vaMaestroJsonString(library)
                    vaMaestroJsonString(cell)
                    vaMaestroJsonString(view)
                    vaMaestroJsonString(getVersion(t))
                    vaMaestroJsonString(session)
                    vaMaestroJsonBoolean(singleTest)
                    vaMaestroJsonBoolean(modified)
                    vaMaestroJsonValue(runMode)
                    if(setupLibrary && stringp(setupLibrary) && strlen(setupLibrary) > 0 then vaMaestroJsonString(setupLibrary) else "null")
                    vaMaestroJsonBoolean(closeResult)
                    vaMaestroJsonValue(storagePath)
                    vaMaestroCount(tests)
                    vaMaestroCount(enabledTests)
                    vaMaestroCount(variables)
                    testVariableEntries
                    uniqueTestVariables
                    vaMaestroCount(parameters)
                    vaMaestroCount(enabledParameters)
                    vaMaestroCount(parameters) - vaMaestroCount(enabledParameters)
                    parameterValueCount
                    vaMaestroCount(corners)
                    analysisEntries
                    outputEntries
                    globalVariableJson
                    parameterJson
                    testJson
                )

                vaMaestroEmitOk(manifest resultPath)
            )
        )
    )
)

procedure(vaInspectMaestro(library cell view)
    vaInspectMaestroInternal(library cell view nil)
)

procedure(vaSessionInspectMaestro(library cell view resultPath)
    vaInspectMaestroInternal(library cell view resultPath)
)
